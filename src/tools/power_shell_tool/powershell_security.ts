/**
 * Fail-closed AST-based security validator for PowerShell commands.
 *
 * Defends against:
 * - Syntax/parse failures (`valid: false`)
 * - Stop-parsing (`--%`), `using module/assembly`, `#Requires`, `ParamBlock`
 * - `Invoke-Expression` / `iex` (including module-qualified forms)
 * - Dynamic command names (`& ('i'+'ex')`, `& $fn`, dot-sourcing `. ./script.ps1`)
 * - Nested `pwsh`/`powershell` & `-EncodedCommand`
 * - Download cradles (`iwr`/`irm`/`curl`/`wget`/`Start-BitsTransfer` + `iex`)
 * - Disallowed `.NET` type literals outside `CLM_ALLOWED_TYPES` (`[System.Diagnostics.Process]`, `[Net.WebClient]`, `[adsi]`, `[wmi]`, etc.)
 * - Subexpressions `$()`, scriptblocks `{}`, member invocations `.Invoke()` / `::Start()`, splatting `@var`
 * - UNC path exfiltration (`\\server\share`, `//server/share`, `FileSystem::\\server\share`)
 * - File redirections (`>`, `>>`, `*>`) other than `$null`
 */

import {
  DANGEROUS_SCRIPT_BLOCK_CMDLETS,
  DOWNLOADER_CMDLETS,
  FILEPATH_EXECUTION_CMDLETS,
  MODULE_LOADING_CMDLETS,
  resolvePsAlias,
} from '../../utilities/powershell/dangerous_cmdlets.js'
import {
  commandHasArgAbbreviation,
  getAllCommands,
  hasCommandNamed,
  type ParsedPowerShellCommand,
} from '../../utilities/powershell/parser.js'
import { isClmAllowedType } from './clm_types.js'

export interface PowerShellSecurityResult {
  behavior: 'passthrough' | 'ask'
  message?: string
}

const POWERSHELL_EXECUTABLES = new Set([
  'pwsh',
  'pwsh.exe',
  'powershell',
  'powershell.exe',
])

function isPowerShellExecutable(name: string): boolean {
  const lower = name.toLowerCase()
  if (POWERSHELL_EXECUTABLES.has(lower)) return true
  const lastSep = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'))
  if (lastSep >= 0) {
    return POWERSHELL_EXECUTABLES.has(lower.slice(lastSep + 1))
  }
  return false
}

/**
 * Detects UNC paths (`\\host\share`, `//host/share`, `FileSystem::\\host\share`,
 * `\\?\UNC\host\share`) that trigger SMB credential leaks / NTLM exfiltration
 * on Windows.
 */
export function containsUncPath(text: string): boolean {
  return (
    /(?:^|[\s'"=(,;])(?:\\\\[A-Za-z0-9._-]+\\|\/\/[A-Za-z0-9._-]+\/)/.test(
      text,
    ) ||
    /::\s*(?:\\\\|\/\/)/.test(text) ||
    /\\\\\?\\UNC\\/i.test(text)
  )
}

export function powershellCommandIsSafe(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 1. Fail closed on parse error or unavailable native parser
  if (!parsed.valid) {
    return {
      behavior: 'ask',
      message: `PowerShell AST parse failed: ${(parsed.parseError ?? parsed.errors.join('; ')) || 'invalid syntax'}`,
    }
  }

  const sp = parsed.securityPatterns

  // 2. Stop-parsing, using, #Requires, ParamBlock
  if (sp.hasStopParsing) {
    return {
      behavior: 'ask',
      message: 'Command uses PowerShell stop-parsing token (--%) which bypasses AST validation',
    }
  }
  if (sp.hasUsingStatement) {
    return {
      behavior: 'ask',
      message: 'Command uses PowerShell `using` directive which can load arbitrary modules/assemblies',
    }
  }
  if (sp.hasRequires) {
    return {
      behavior: 'ask',
      message: 'Command uses #Requires directive which requires confirmation',
    }
  }
  if (sp.hasParamBlock) {
    return {
      behavior: 'ask',
      message: 'Command defines a Param() block which requires confirmation',
    }
  }

  // 3. Dynamic invocation / dot-sourcing / call operator / splatting
  if (sp.hasDotSourcing) {
    return {
      behavior: 'ask',
      message: 'Command uses dot-sourcing (.) which executes scripts in the current scope',
    }
  }
  if (sp.hasDynamicCommandName || sp.hasCallOperator) {
    return {
      behavior: 'ask',
      message: 'Command uses dynamic invocation (& or expression command name)',
    }
  }
  if (sp.hasSplatting) {
    return {
      behavior: 'ask',
      message: 'Command uses parameter splatting (@var) which obscures arguments',
    }
  }

  // 4. Subexpressions, scriptblocks, and .NET member invocations
  if (sp.hasSubExpression) {
    return {
      behavior: 'ask',
      message: 'Command contains PowerShell subexpression $() or @() evaluation',
    }
  }
  if (sp.hasScriptBlock) {
    return {
      behavior: 'ask',
      message: 'Command contains script block {} execution',
    }
  }
  if (sp.hasMemberInvocation) {
    return {
      behavior: 'ask',
      message: 'Command invokes .NET or object methods (.Method() / ::Method())',
    }
  }

  // 5. CLM .NET type allowlist check
  for (const typeName of parsed.typeLiterals) {
    if (!isClmAllowedType(typeName)) {
      return {
        behavior: 'ask',
        message: `Command references restricted .NET type [${typeName}] outside Constrained Language Mode allowlist`,
      }
    }
  }

  // 6. UNC path exfiltration guard
  if (containsUncPath(parsed.rawCommand)) {
    return {
      behavior: 'ask',
      message: 'Command references a UNC network share path (potential NTLM/SMB exfiltration)',
    }
  }

  // 7. Invoke-Expression / iex & download cradles
  const allCommands = getAllCommands(parsed)
  const hasIex = hasCommandNamed(parsed, 'invoke-expression')
  const hasDownloader = allCommands.some(cmd =>
    DOWNLOADER_CMDLETS.has(resolvePsAlias(cmd.name)),
  )

  if (hasDownloader && hasIex) {
    return {
      behavior: 'ask',
      message: 'Command matches download-and-execute cradle pattern (downloader + Invoke-Expression)',
    }
  }

  if (hasIex) {
    return {
      behavior: 'ask',
      message: 'Command uses Invoke-Expression (iex) which executes arbitrary code',
    }
  }

  // 8. Inspect each command for nested PowerShell, encoded commands, dangerous cmdlets, COM objects
  for (const cmd of allCommands) {
    if (isPowerShellExecutable(cmd.name)) {
      if (commandHasArgAbbreviation(cmd, '-encodedcommand', '-e')) {
        return {
          behavior: 'ask',
          message: 'Command spawns PowerShell with -EncodedCommand',
        }
      }
      return {
        behavior: 'ask',
        message: 'Command spawns a nested PowerShell process which cannot be statically validated',
      }
    }

    const canonical = resolvePsAlias(cmd.name)

    if (
      canonical === 'new-object' &&
      commandHasArgAbbreviation(cmd, '-comobject', '-com')
    ) {
      return {
        behavior: 'ask',
        message: 'Command instantiates a COM object via New-Object -ComObject',
      }
    }

    if (
      DANGEROUS_SCRIPT_BLOCK_CMDLETS.has(canonical) ||
      FILEPATH_EXECUTION_CMDLETS.has(canonical) ||
      MODULE_LOADING_CMDLETS.has(canonical)
    ) {
      return {
        behavior: 'ask',
        message: `Command invokes sensitive PowerShell cmdlet '${canonical}'`,
      }
    }
  }

  // 9. File redirections (allow redirecting to $null only)
  for (const redir of parsed.fileRedirections) {
    const loc = redir.location.trim().toLowerCase()
    if (loc !== '$null') {
      return {
        behavior: 'ask',
        message: `Command contains PowerShell file redirection to '${redir.location}'`,
      }
    }
  }

  return { behavior: 'passthrough' }
}
