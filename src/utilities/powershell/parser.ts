/**
 * LRU-cached native PowerShell AST parser invoking PowerShell's built-in
 * `[System.Management.Automation.Language.Parser]::ParseInput` via UTF-16LE
 * `-EncodedCommand`.
 *
 * SECURITY PROPERTIES:
 * - Strictly fail-closed: returns `{ valid: false }` on over-length input
 *   (`> 10_000` chars), parse errors, missing PowerShell binary, timeout, or
 *   malformed JSON output.
 * - Uses native PowerShell's own lexer/parser rather than fragile regexes,
 *   accurately surfacing type literals, redirections, subexpressions,
 *   scriptblocks, member invocations, stop-parsing (`--%`), `using`, `#Requires`,
 *   dynamic command names, dot-sourcing, and splatting.
 */

import { execFileNoThrow } from '../exec_file_no_throw.js'
import { findPowerShell } from '../shell/powershell_detection.js'
import {
  COMMON_PS_ALIASES,
  resolvePsAlias,
  stripModulePrefix,
} from './dangerous_cmdlets.js'

export const MAX_PS_COMMAND_LENGTH = 10_000
const PARSE_TIMEOUT_MS = 10_000
const LRU_CACHE_CAPACITY = 256

export interface ParsedCommandElement {
  name: string
  args: string[]
  elementType: string
  elementTypes: string[]
  invocationOperator: string
  text: string
}

export interface ParsedFileRedirection {
  stream: string
  append: boolean
  location: string
}

export interface ParsedStatement {
  text: string
  commands: ParsedCommandElement[]
}

export interface PowerShellSecurityPatterns {
  hasStopParsing: boolean
  hasUsingStatement: boolean
  hasRequires: boolean
  hasParamBlock: boolean
  hasSubExpression: boolean
  hasScriptBlock: boolean
  hasMemberInvocation: boolean
  hasSplatting: boolean
  hasDotSourcing: boolean
  hasCallOperator: boolean
  hasDynamicCommandName: boolean
  hasExpandableStringSubExpr: boolean
}

export interface ParsedPowerShellCommand {
  valid: boolean
  rawCommand: string
  errors: string[]
  statements: ParsedStatement[]
  typeLiterals: string[]
  fileRedirections: ParsedFileRedirection[]
  securityPatterns: PowerShellSecurityPatterns
  parseError?: string
}

export const PS_TOKENIZER_DASH_CHARS = new Set([
  '-',
  '/',
  '\u2013',
  '\u2014',
  '\u2015',
])

const EMPTY_SECURITY_PATTERNS: PowerShellSecurityPatterns = {
  hasStopParsing: false,
  hasUsingStatement: false,
  hasRequires: false,
  hasParamBlock: false,
  hasSubExpression: false,
  hasScriptBlock: false,
  hasMemberInvocation: false,
  hasSplatting: false,
  hasDotSourcing: false,
  hasCallOperator: false,
  hasDynamicCommandName: false,
  hasExpandableStringSubExpr: false,
}

/**
 * PowerShell script that parses a base64-encoded UTF-8 input string using
 * `[System.Management.Automation.Language.Parser]::ParseInput` and prints a
 * compact JSON AST summary to stdout.
 */
function buildAstParserScript(commandBase64Utf8: string): string {
  return `
$ErrorActionPreference = 'Stop'
$raw = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${commandBase64Utf8}'))
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($raw, [ref]$tokens, [ref]$parseErrors)

$errList = @()
if ($parseErrors) {
  foreach ($e in $parseErrors) { $errList += $e.Message }
}

$hasStopParsing = $false
if ($tokens) {
  foreach ($t in $tokens) {
    if ($t.Kind -eq [System.Management.Automation.Language.TokenKind]::EndOfInput) { continue }
    if ($t.Text -eq '--%') { $hasStopParsing = $true }
  }
}

$hasUsing = ($null -ne $ast.UsingStatements -and $ast.UsingStatements.Count -gt 0)
$hasRequires = ($null -ne $ast.ScriptRequirements)
$hasParamBlock = ($null -ne $ast.ParamBlock)

$subExprs = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.SubExpressionAst] -or $n -is [System.Management.Automation.Language.ArrayExpressionAst] }, $true)
$scriptBlocks = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.ScriptBlockExpressionAst] }, $true)
$memberInvokes = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)
$splats = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.VariableExpressionAst] -and $n.Splatted }, $true)

$typeNodes = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.TypeExpressionAst] -or $n -is [System.Management.Automation.Language.TypeConstraintAst] }, $true)
$typeLiterals = @()
foreach ($tn in $typeNodes) {
  if ($tn.TypeName -and $tn.TypeName.FullName) { $typeLiterals += $tn.TypeName.FullName }
  elseif ($tn.TypeName -and $tn.TypeName.Name) { $typeLiterals += $tn.TypeName.Name }
}

$redirNodes = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FileRedirectionAst] }, $true)
$fileRedirs = @()
foreach ($rn in $redirNodes) {
  $fileRedirs += [PSCustomObject]@{
    stream = [string]$rn.FromStream
    append = [bool]$rn.Append
    location = if ($rn.Location) { $rn.Location.Extent.Text } else { '' }
  }
}

$hasDotSourcing = $false
$hasCallOperator = $false
$hasDynamicName = $false

$statements = @()
$pipelines = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.PipelineAst] }, $true)
foreach ($pipe in $pipelines) {
  $cmds = @()
  foreach ($el in $pipe.PipelineElements) {
    if ($el -is [System.Management.Automation.Language.CommandAst]) {
      $invOp = [string]$el.InvocationOperator
      if ($invOp -eq 'Dot') { $hasDotSourcing = $true }
      if ($invOp -eq 'Ampersand') { $hasCallOperator = $true }

      $elTypes = @()
      $cmdArgs = @()
      $cmdName = ''
      for ($idx = 0; $idx -lt $el.CommandElements.Count; $idx++) {
        $ce = $el.CommandElements[$idx]
        $kindName = 'Other'
        if ($ce -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $kindName = 'StringConstant' }
        elseif ($ce -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) { $kindName = 'ExpandableString' }
        elseif ($ce -is [System.Management.Automation.Language.CommandParameterAst]) { $kindName = 'Parameter' }
        elseif ($ce -is [System.Management.Automation.Language.VariableExpressionAst]) { $kindName = 'Variable' }
        elseif ($ce -is [System.Management.Automation.Language.ConstantExpressionAst]) { $kindName = 'Constant' }
        $elTypes += $kindName

        if ($idx -eq 0) {
          if ($ce -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
            $cmdName = $ce.Value
          } else {
            $cmdName = $ce.Extent.Text
            $hasDynamicName = $true
          }
        } else {
          if ($ce -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
            $cmdArgs += $ce.Value
          } else {
            $cmdArgs += $ce.Extent.Text
          }
        }
      }

      $cmds += [PSCustomObject]@{
        name = $cmdName
        args = $cmdArgs
        elementType = 'CommandAst'
        elementTypes = $elTypes
        invocationOperator = $invOp
        text = $el.Extent.Text
      }
    }
  }
  if ($cmds.Count -gt 0) {
    $statements += [PSCustomObject]@{
      text = $pipe.Extent.Text
      commands = $cmds
    }
  }
}

$result = [PSCustomObject]@{
  valid = ($errList.Count -eq 0)
  errors = $errList
  statements = $statements
  typeLiterals = $typeLiterals
  fileRedirections = $fileRedirs
  securityPatterns = [PSCustomObject]@{
    hasStopParsing = $hasStopParsing
    hasUsingStatement = $hasUsing
    hasRequires = $hasRequires
    hasParamBlock = $hasParamBlock
    hasSubExpression = ($subExprs.Count -gt 0)
    hasScriptBlock = ($scriptBlocks.Count -gt 0)
    hasMemberInvocation = ($memberInvokes.Count -gt 0)
    hasSplatting = ($splats.Count -gt 0)
    hasDotSourcing = $hasDotSourcing
    hasCallOperator = $hasCallOperator
    hasDynamicCommandName = $hasDynamicName
    hasExpandableStringSubExpr = ($subExprs.Count -gt 0)
  }
}

$result | ConvertTo-Json -Depth 8 -Compress
`.trim()
}

// Simple LRU cache (Map preserves insertion order)
const parseCache = new Map<string, ParsedPowerShellCommand>()

function getCached(command: string): ParsedPowerShellCommand | undefined {
  const hit = parseCache.get(command)
  if (hit) {
    parseCache.delete(command)
    parseCache.set(command, hit)
  }
  return hit
}

function setCached(command: string, result: ParsedPowerShellCommand): void {
  if (parseCache.size >= LRU_CACHE_CAPACITY) {
    const oldestKey = parseCache.keys().next().value
    if (oldestKey !== undefined) {
      parseCache.delete(oldestKey)
    }
  }
  parseCache.set(command, result)
}

export function clearPowerShellParserCacheForTesting(): void {
  parseCache.clear()
}

export function getPowerShellParserCacheSizeForTesting(): number {
  return parseCache.size
}

function makeFailedParse(
  rawCommand: string,
  error: string,
): ParsedPowerShellCommand {
  return {
    valid: false,
    rawCommand,
    errors: [error],
    statements: [],
    typeLiterals: [],
    fileRedirections: [],
    securityPatterns: { ...EMPTY_SECURITY_PATTERNS },
    parseError: error,
  }
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(v => String(v))
  }
  if (typeof value === 'string') {
    return [value]
  }
  return []
}

function toObjectArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
    )
  }
  if (typeof value === 'object' && value !== null) {
    return [value as Record<string, unknown>]
  }
  return []
}

/**
 * Parses a PowerShell command using the host's native PowerShell AST engine,
 * with LRU caching and strict fail-closed semantics.
 */
export async function parsePowerShellCommand(
  command: string,
): Promise<ParsedPowerShellCommand> {
  if (!command.trim()) {
    return makeFailedParse(command, 'Empty PowerShell command')
  }

  if (command.length > MAX_PS_COMMAND_LENGTH) {
    return makeFailedParse(
      command,
      `PowerShell command length (${command.length}) exceeds maximum (${MAX_PS_COMMAND_LENGTH})`,
    )
  }

  const cached = getCached(command)
  if (cached) {
    return cached
  }

  const ps = findPowerShell()
  if (!ps) {
    return makeFailedParse(
      command,
      'PowerShell executable unavailable for native AST parsing',
    )
  }

  const commandB64 = Buffer.from(command, 'utf8').toString('base64')
  const script = buildAstParserScript(commandB64)
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64')

  const execRes = await execFileNoThrow(
    ps.path,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript],
    { timeout: PARSE_TIMEOUT_MS },
  )

  if (execRes.code !== 0 || !execRes.stdout.trim()) {
    return makeFailedParse(
      command,
      execRes.stderr.trim() || `PowerShell AST parser exited with code ${execRes.code}`,
    )
  }

  try {
    const rawJson = JSON.parse(execRes.stdout.trim()) as Record<string, unknown>
    const statementsRaw = toObjectArray(rawJson.statements)
    const statements: ParsedStatement[] = statementsRaw.map(stmt => {
      const cmdsRaw = toObjectArray(stmt.commands)
      return {
        text: String(stmt.text ?? ''),
        commands: cmdsRaw.map(cmd => ({
          name: String(cmd.name ?? ''),
          args: toStringArray(cmd.args),
          elementType: String(cmd.elementType ?? 'CommandAst'),
          elementTypes: toStringArray(cmd.elementTypes),
          invocationOperator: String(cmd.invocationOperator ?? 'Unknown'),
          text: String(cmd.text ?? ''),
        })),
      }
    })

    const fileRedirsRaw = toObjectArray(rawJson.fileRedirections)
    const fileRedirections: ParsedFileRedirection[] = fileRedirsRaw.map(r => ({
      stream: String(r.stream ?? 'Output'),
      append: Boolean(r.append),
      location: String(r.location ?? ''),
    }))

    const spRaw =
      typeof rawJson.securityPatterns === 'object' &&
      rawJson.securityPatterns !== null
        ? (rawJson.securityPatterns as Record<string, unknown>)
        : {}

    const parsed: ParsedPowerShellCommand = {
      valid: Boolean(rawJson.valid),
      rawCommand: command,
      errors: toStringArray(rawJson.errors),
      statements,
      typeLiterals: toStringArray(rawJson.typeLiterals),
      fileRedirections,
      securityPatterns: {
        hasStopParsing: Boolean(spRaw.hasStopParsing),
        hasUsingStatement: Boolean(spRaw.hasUsingStatement),
        hasRequires: Boolean(spRaw.hasRequires),
        hasParamBlock: Boolean(spRaw.hasParamBlock),
        hasSubExpression: Boolean(spRaw.hasSubExpression),
        hasScriptBlock: Boolean(spRaw.hasScriptBlock),
        hasMemberInvocation: Boolean(spRaw.hasMemberInvocation),
        hasSplatting: Boolean(spRaw.hasSplatting),
        hasDotSourcing: Boolean(spRaw.hasDotSourcing),
        hasCallOperator: Boolean(spRaw.hasCallOperator),
        hasDynamicCommandName: Boolean(spRaw.hasDynamicCommandName),
        hasExpandableStringSubExpr: Boolean(spRaw.hasExpandableStringSubExpr),
      },
    }

    setCached(command, parsed)
    return parsed
  } catch (error) {
    return makeFailedParse(
      command,
      `Failed to parse PowerShell AST JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function getAllCommands(
  parsed: ParsedPowerShellCommand,
): ParsedCommandElement[] {
  const out: ParsedCommandElement[] = []
  for (const stmt of parsed.statements) {
    for (const cmd of stmt.commands) {
      out.push(cmd)
    }
  }
  return out
}

export function getAllCommandNames(parsed: ParsedPowerShellCommand): string[] {
  return getAllCommands(parsed).map(cmd => cmd.name)
}

export function hasCommandNamed(
  parsed: ParsedPowerShellCommand,
  canonicalName: string,
): boolean {
  const target = canonicalName.toLowerCase()
  return getAllCommands(parsed).some(cmd => resolvePsAlias(cmd.name) === target)
}

export function getFileRedirections(
  parsed: ParsedPowerShellCommand,
): ParsedFileRedirection[] {
  return parsed.fileRedirections
}

/**
 * Checks if `cmd.args` includes a PowerShell parameter abbreviation matching
 * `fullParam` (at least `minPrefix`), accounting for `:value` syntax and
 * alternative dash characters (`/`, en-dash, em-dash, horizontal bar).
 */
export function commandHasArgAbbreviation(
  cmd: ParsedCommandElement,
  fullParam: string,
  minPrefix: string,
): boolean {
  const fullLower = fullParam.toLowerCase()
  const minLower = minPrefix.toLowerCase()

  for (const rawArg of cmd.args) {
    if (!rawArg) continue
    const firstChar = rawArg[0]!
    if (!PS_TOKENIZER_DASH_CHARS.has(firstChar)) continue
    const normalized = '-' + rawArg.slice(1).split(':')[0]!.toLowerCase()
    if (
      normalized.length >= minLower.length &&
      normalized.startsWith(minLower) &&
      fullLower.startsWith(normalized)
    ) {
      return true
    }
  }
  return false
}

export { COMMON_PS_ALIASES, resolvePsAlias, stripModulePrefix }
