/**
 * Multi-scope skill discovery (`policySettings`, `~/.copilot/skills`,
 * `.copilot/skills`, `--add-dir`, and legacy `commands/`), `realpath`
 * deduplication, lazy subdirectory discovery, `paths:` conditional activation,
 * variable substitution, and trusted-only inline shell expansion.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { realpath } from 'fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'path'
import picomatch from 'picomatch'
import {
  getAdditionalDirectoriesForClaudeMd,
  getAllowedSettingSources,
  getSessionId,
} from '../bootstrap/state.js'
import { HooksSchema } from '../schemas/hooks.js'
import { roughTokenCountEstimation } from '../services/token_estimation.js'
import type { Command } from '../types/command.js'
import type { SettingSource } from '../types/forward.js'
import { substituteArguments } from '../utilities/argument_substitution.js'
import { getCwd } from '../utilities/cwd.js'
import { parseEffortValue } from '../utilities/effort.js'
import {
  getClaudeConfigHomeDir,
  isBareMode,
  isEnvTruthy,
} from '../utilities/env_utils.js'
import {
  coerceDescriptionToString,
  parseBooleanFrontmatter,
  parseFrontmatter,
  parseShellFrontmatter,
  splitPathInFrontmatter,
  type FrontmatterData,
} from '../utilities/frontmatter_parser.js'
import { isPathGitignored } from '../utilities/git/gitignore.js'
import {
  extractDescriptionFromMarkdown,
  getProjectDirsUpToHome,
  loadMarkdownFilesForSubdir,
  parseSlashCommandToolsFromFrontmatter,
} from '../utilities/markdown_config_loader.js'
import { parseUserSpecifiedModel } from '../utilities/model/model.js'
import { executeShellCommandsInPrompt } from '../utilities/prompt_shell_execution.js'
import { getManagedFilePath } from '../utilities/settings/managed_path.js'
import { isRestrictedToPluginOnly } from '../utilities/settings/plugin_only_policy.js'
import { createSignal } from '../utilities/signal.js'
import {
  registerMcpSkillBuilders,
  type CreateSkillCommandParams,
  type ParsedSkillFrontmatter,
} from './mcp_skill_builders.js'

const dynamicSkillDirsChecked = new Set<string>()
const dynamicSkillsMap = new Map<string, Command>()
const conditionalSkillsMap = new Map<string, Command>()
const activatedConditionalSkillNames = new Set<string>()
let cachedUnconditionalSkills: { cwd: string; commands: Command[] } | null =
  null

const dynamicSkillsLoadedSignal = createSignal<[]>()

/**
 * Subscribes to lazy subdirectory or `paths:` conditional skill activations.
 */
export const onDynamicSkillsLoaded = dynamicSkillsLoadedSignal.subscribe

function parseArgumentNames(raw: unknown): string[] | undefined {
  if (!raw) return undefined
  const tokens = Array.isArray(raw)
    ? raw.map(v => String(v).trim())
    : typeof raw === 'string'
      ? raw.trim().split(/[\s,]+/)
      : []
  const valid = tokens.filter(t => t.length > 0 && !/^\d+$/.test(t))
  return valid.length > 0 ? valid : undefined
}

function parseSkillPaths(frontmatter: FrontmatterData): string[] | undefined {
  if (!frontmatter.paths) {
    return undefined
  }
  const expanded = splitPathInFrontmatter(frontmatter.paths)
    .map(p => p.trim())
    .filter(Boolean)
  if (expanded.length === 0 || expanded.every(p => p === '**' || p === '*')) {
    return undefined
  }
  return expanded
}

/**
 * Parses all supported YAML frontmatter fields on a skill or command markdown file.
 */
export function parseSkillFrontmatterFields(
  frontmatter: FrontmatterData,
  markdownBody: string,
  fallbackName: string,
): ParsedSkillFrontmatter {
  const displayName =
    typeof frontmatter.name === 'string' && frontmatter.name.trim()
      ? frontmatter.name.trim()
      : undefined
  const validatedDescription = coerceDescriptionToString(
    frontmatter.description,
    displayName ?? fallbackName,
  )
  const description =
    validatedDescription ??
    extractDescriptionFromMarkdown(markdownBody, 'Skill')
  const whenToUse =
    typeof frontmatter.when_to_use === 'string' &&
    frontmatter.when_to_use.trim()
      ? frontmatter.when_to_use.trim()
      : undefined
  const argumentHint =
    typeof frontmatter['argument-hint'] === 'string' &&
    frontmatter['argument-hint'].trim()
      ? frontmatter['argument-hint'].trim()
      : undefined
  const argumentNames = parseArgumentNames(frontmatter.arguments)
  const allowedTools = parseSlashCommandToolsFromFrontmatter(
    frontmatter['allowed-tools'],
  )
  const model =
    typeof frontmatter.model === 'string' &&
    frontmatter.model.trim() &&
    frontmatter.model.trim().toLowerCase() !== 'inherit'
      ? parseUserSpecifiedModel(frontmatter.model.trim())
      : undefined
  const effort =
    frontmatter.effort !== undefined && frontmatter.effort !== null
      ? parseEffortValue(String(frontmatter.effort))
      : undefined
  const context =
    frontmatter.context === 'fork'
      ? 'fork'
      : frontmatter.context === 'inline'
        ? 'inline'
        : undefined
  const agent =
    typeof frontmatter.agent === 'string' && frontmatter.agent.trim()
      ? frontmatter.agent.trim()
      : undefined
  const userInvocable =
    frontmatter['user-invocable'] === undefined ||
    frontmatter['user-invocable'] === null
      ? true
      : parseBooleanFrontmatter(frontmatter['user-invocable'])
  const disableModelInvocation =
    parseBooleanFrontmatter(frontmatter['disable-model-invocation']) ||
    parseBooleanFrontmatter(frontmatter['hide-from-slash-command-tool'])

  let hooks: Record<string, unknown[]> | undefined
  if (frontmatter.hooks && typeof frontmatter.hooks === 'object') {
    const parsedHooks = HooksSchema().safeParse(frontmatter.hooks)
    if (parsedHooks.success) {
      hooks = parsedHooks.data
    }
  }

  const paths = parseSkillPaths(frontmatter)
  const shell = parseShellFrontmatter(
    frontmatter.shell,
    displayName ?? fallbackName,
  )

  return {
    displayName,
    description,
    hasUserSpecifiedDescription: validatedDescription !== null,
    whenToUse,
    argumentHint,
    argumentNames,
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
    model,
    effort,
    context,
    agent,
    userInvocable,
    disableModelInvocation,
    hooks,
    paths,
    shell,
  }
}

/**
 * Constructs a `PromptCommand` from parsed skill Markdown and frontmatter,
 * performing `$ARGUMENTS`, `${COPILOT_SKILL_DIR}`, `${COPILOT_SESSION_ID}`, and
 * trusted-only inline shell expansion on invocation.
 */
export function createSkillCommand(params: CreateSkillCommandParams): Command {
  const fields = parseSkillFrontmatterFields(
    params.frontmatter,
    params.markdownContent,
    params.name,
  )
  const resolvedName = fields.displayName ?? params.name

  return {
    type: 'prompt',
    name: resolvedName,
    userFacingName: () => resolvedName,
    description: fields.description,
    hasUserSpecifiedDescription: fields.hasUserSpecifiedDescription,
    whenToUse: fields.whenToUse,
    argumentHint: fields.argumentHint,
    argNames: fields.argumentNames,
    allowedTools: fields.allowedTools,
    model: fields.model,
    effort: fields.effort,
    context: fields.context,
    agent: fields.agent,
    userInvocable: fields.userInvocable,
    isHidden: !fields.userInvocable,
    disableModelInvocation: fields.disableModelInvocation,
    hooks: fields.hooks,
    paths: fields.paths,
    skillRoot: params.baseDir,
    source: params.source,
    loadedFrom: params.loadedFrom,
    pluginInfo: params.pluginInfo,
    progressMessage: `Running ${resolvedName}…`,
    contentLength: params.markdownContent.length,

    async getPromptForCommand(args, context): Promise<ContentBlockParam[]> {
      let body = params.markdownContent

      // 1. Argument substitution ($ARGUMENTS, $ARGUMENTS[i], $1, named args)
      body = substituteArguments(body, args, true, fields.argumentNames)

      // 2. Skill directory & session ID variables
      if (params.baseDir) {
        const normalizedSkillDir =
          process.platform === 'win32'
            ? params.baseDir.replace(/\\/g, '/')
            : params.baseDir
        body = body.replace(
          /\$\{(?:COPILOT|CLAUDE)_SKILL_DIR\}/g,
          () => normalizedSkillDir,
        )
      }
      const sessionId = getSessionId()
      body = body.replace(
        /\$\{(?:COPILOT|CLAUDE)_SESSION_ID\}/g,
        () => sessionId,
      )

      // 3. Inline shell execution — NEVER run for untrusted MCP skills!
      if (params.loadedFrom !== 'mcp' && params.source !== 'mcp') {
        body = await executeShellCommandsInPrompt(body, context, {
          shell: fields.shell,
          allowedTools: fields.allowedTools,
        })
      }

      const fullPrompt = params.baseDir
        ? `Base directory for this skill: ${params.baseDir}\n\n${body}`
        : body

      return [{ type: 'text', text: fullPrompt }]
    },
  }
}

interface RawSkillCandidate {
  name: string
  filePath: string
  baseDir: string
  frontmatter: FrontmatterData
  content: string
  source: SettingSource
  loadedFrom: 'skills' | 'commands_DEPRECATED' | 'managed'
}

function scanSkillsDirectory(
  skillsRootDir: string,
  source: SettingSource,
  loadedFrom: 'skills' | 'managed' = 'skills',
): RawSkillCandidate[] {
  if (!existsSync(skillsRootDir)) {
    return []
  }
  let entries
  try {
    entries = readdirSync(skillsRootDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
  } catch {
    return []
  }

  const candidates: RawSkillCandidate[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      // Only `<skills>/<skill-name>/SKILL.md` directories are loaded in `/skills/`
      continue
    }
    const skillDir = join(skillsRootDir, entry.name)
    const skillFile = join(skillDir, 'SKILL.md')
    if (!existsSync(skillFile)) {
      continue
    }
    try {
      const raw = readFileSync(skillFile, 'utf8')
      const parsed = parseFrontmatter(raw, skillFile)
      candidates.push({
        name: entry.name,
        filePath: skillFile,
        baseDir: skillDir,
        frontmatter: parsed.frontmatter,
        content: parsed.content.trim(),
        source,
        loadedFrom,
      })
    } catch {
      // Skip unreadable SKILL.md
    }
  }
  return candidates
}

function buildLegacyCommandCandidates(cwd: string): RawSkillCandidate[] {
  const files = loadMarkdownFilesForSubdir('commands', cwd)
  // If a directory contains `SKILL.md`, ignore sibling `.md` files in that directory
  const skillDirs = new Set(
    files
      .filter(f => basename(f.filePath).toLowerCase() === 'skill.md')
      .map(f => dirname(f.filePath)),
  )

  const candidates: RawSkillCandidate[] = []
  for (const file of files) {
    const isSkillMd = basename(file.filePath).toLowerCase() === 'skill.md'
    const parentDir = dirname(file.filePath)
    if (!isSkillMd && skillDirs.has(parentDir)) {
      continue
    }

    const relNoExt = isSkillMd
      ? relative(file.baseDir, parentDir)
      : file.relativePath.slice(0, -extname(file.relativePath).length)
    const colonName = relNoExt
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .join(':')
    if (!colonName) continue

    candidates.push({
      name: colonName,
      filePath: file.filePath,
      baseDir: parentDir,
      frontmatter: file.frontmatter,
      content: file.content,
      source: file.source,
      loadedFrom: 'commands_DEPRECATED',
    })
  }
  return candidates
}

function isSettingSourceEnabled(source: SettingSource): boolean {
  return getAllowedSettingSources().includes(source)
}

/**
 * Loads and deduplicates skills across managed, user (`~/.copilot/skills`),
 * project (`.copilot/skills`), `--add-dir`, and legacy `.copilot/commands`
 * directories, separating `paths:` conditional skills until matching files are
 * accessed.
 */
export async function getSkillDirCommands(
  cwd: string = getCwd(),
): Promise<Command[]> {
  const resolvedCwd = resolve(cwd)
  if (cachedUnconditionalSkills?.cwd === resolvedCwd) {
    return [
      ...cachedUnconditionalSkills.commands,
      ...Array.from(dynamicSkillsMap.values()),
    ]
  }

  const skillsLocked = isRestrictedToPluginOnly('skills')
  const rawCandidates: RawSkillCandidate[] = []

  if (isBareMode()) {
    if (!skillsLocked && isSettingSourceEnabled('projectSettings')) {
      for (const addDir of getAdditionalDirectoriesForClaudeMd()) {
        rawCandidates.push(
          ...scanSkillsDirectory(
            join(addDir, '.copilot', 'skills'),
            'projectSettings',
          ),
        )
      }
    }
  } else {
    if (
      !isEnvTruthy(process.env.COPILOT_CLI_DISABLE_POLICY_SKILLS) &&
      isSettingSourceEnabled('policySettings')
    ) {
      rawCandidates.push(
        ...scanSkillsDirectory(
          join(getManagedFilePath(), '.copilot', 'skills'),
          'policySettings',
          'managed',
        ),
      )
    }

    if (!skillsLocked && isSettingSourceEnabled('userSettings')) {
      rawCandidates.push(
        ...scanSkillsDirectory(
          join(getClaudeConfigHomeDir(), 'skills'),
          'userSettings',
        ),
      )
    }

    if (!skillsLocked && isSettingSourceEnabled('projectSettings')) {
      for (const projSkillsDir of getProjectDirsUpToHome(
        'skills',
        resolvedCwd,
      )) {
        rawCandidates.push(
          ...scanSkillsDirectory(projSkillsDir, 'projectSettings'),
        )
      }
      for (const addDir of getAdditionalDirectoriesForClaudeMd()) {
        rawCandidates.push(
          ...scanSkillsDirectory(
            join(addDir, '.copilot', 'skills'),
            'projectSettings',
          ),
        )
      }
    }

    if (!skillsLocked) {
      rawCandidates.push(...buildLegacyCommandCandidates(resolvedCwd))
    }
  }

  // Parallel realpath resolution for symlink deduplication
  const realpaths = await Promise.all(
    rawCandidates.map(c => realpath(c.filePath).catch(() => null)),
  )

  const seenFiles = new Set<string>()
  const unconditional: Command[] = []
  conditionalSkillsMap.clear()

  for (let i = 0; i < rawCandidates.length; i++) {
    const candidate = rawCandidates[i]!
    const rp = realpaths[i]
    if (rp) {
      const key = process.platform === 'win32' ? rp.toLowerCase() : rp
      if (seenFiles.has(key)) {
        continue
      }
      seenFiles.add(key)
    }

    const command = createSkillCommand({
      name: candidate.name,
      markdownContent: candidate.content,
      frontmatter: candidate.frontmatter,
      source: candidate.source,
      loadedFrom: candidate.loadedFrom,
      baseDir: candidate.baseDir,
      filePath: candidate.filePath,
    })

    if (
      command.type === 'prompt' &&
      command.paths &&
      command.paths.length > 0 &&
      !activatedConditionalSkillNames.has(command.name)
    ) {
      conditionalSkillsMap.set(command.name, command)
    } else {
      unconditional.push(command)
    }
  }

  cachedUnconditionalSkills = {
    cwd: resolvedCwd,
    commands: unconditional,
  }

  return [...unconditional, ...Array.from(dynamicSkillsMap.values())]
}

/**
 * Activates any `paths:` conditional skills whose glob pattern matches one of
 * `filePaths` relative to `cwd`.
 */
export function activateConditionalSkillsForPaths(
  filePaths: readonly string[],
  cwd: string = getCwd(),
): string[] {
  if (conditionalSkillsMap.size === 0 || filePaths.length === 0) {
    return []
  }

  const resolvedCwd = resolve(cwd)
  const activated: string[] = []

  for (const rawPath of filePaths) {
    const rel = relative(resolvedCwd, resolve(resolvedCwd, rawPath)).replace(
      /\\/g,
      '/',
    )
    if (!rel || rel.startsWith('..')) {
      continue
    }

    for (const [skillName, cmd] of conditionalSkillsMap.entries()) {
      if (cmd.type !== 'prompt' || !cmd.paths) continue
      const matched = cmd.paths.some(pattern => {
        const cleanPattern = pattern.replace(/^\.\//, '')
        try {
          return picomatch.isMatch(rel, cleanPattern, { dot: true })
        } catch {
          return rel.startsWith(cleanPattern.replace(/\/\*\*$/, ''))
        }
      })
      if (matched) {
        conditionalSkillsMap.delete(skillName)
        activatedConditionalSkillNames.add(skillName)
        dynamicSkillsMap.set(skillName, cmd)
        activated.push(skillName)
      }
    }
  }

  if (activated.length > 0) {
    dynamicSkillsLoadedSignal.emit()
  }
  return activated
}

/**
 * Lazily discovers nested `<subdir>/.copilot/skills` directories strictly below
 * `cwd` when file tools touch nested workspace paths, skipping gitignored dirs
 * such as `node_modules`.
 */
export async function discoverSkillDirsForPaths(
  filePaths: readonly string[],
  cwd: string = getCwd(),
): Promise<string[]> {
  if (isRestrictedToPluginOnly('skills') || isBareMode()) {
    return []
  }

  const resolvedCwd = resolve(cwd)
  const cwdPrefix = `${resolvedCwd}${sep}`
  const discovered: string[] = []

  for (const rawPath of filePaths) {
    let cursor = dirname(resolve(resolvedCwd, rawPath))
    while (cursor.startsWith(cwdPrefix)) {
      const candidateSkillsDir = join(cursor, '.copilot', 'skills')
      if (!dynamicSkillDirsChecked.has(candidateSkillsDir)) {
        dynamicSkillDirsChecked.add(candidateSkillsDir)
        if (existsSync(candidateSkillsDir)) {
          const ignored = await isPathGitignored(cursor, resolvedCwd).catch(
            () => false,
          )
          if (!ignored) {
            discovered.push(candidateSkillsDir)
          }
        }
      }
      const parent = dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
  }

  return discovered
}

/**
 * Loads skills from newly discovered nested `.copilot/skills` directories into
 * `dynamicSkillsMap` and notifies listeners.
 */
export async function addSkillDirectories(
  skillDirs: readonly string[],
): Promise<string[]> {
  const addedNames: string[] = []
  // Load shallower directories first so deeper directories override
  for (const dir of [...skillDirs].reverse()) {
    for (const candidate of scanSkillsDirectory(dir, 'projectSettings')) {
      const cmd = createSkillCommand({
        name: candidate.name,
        markdownContent: candidate.content,
        frontmatter: candidate.frontmatter,
        source: 'projectSettings',
        loadedFrom: 'skills',
        baseDir: candidate.baseDir,
        filePath: candidate.filePath,
      })
      dynamicSkillsMap.set(cmd.name, cmd)
      addedNames.push(cmd.name)
    }
  }
  if (addedNames.length > 0) {
    dynamicSkillsLoadedSignal.emit()
  }
  return addedNames
}

/**
 * Estimates frontmatter description token cost for `/skills` UI display.
 */
export function estimateSkillFrontmatterTokens(skill: Command): number {
  const combined = [skill.name, skill.description, skill.whenToUse]
    .filter(Boolean)
    .join(' ')
  return roughTokenCountEstimation(combined)
}

/**
 * Clears all skill discovery caches (invoked by `chokidar` hot reload and tests).
 */
export function clearSkillCaches(): void {
  cachedUnconditionalSkills = null
  dynamicSkillDirsChecked.clear()
  dynamicSkillsMap.clear()
  conditionalSkillsMap.clear()
  activatedConditionalSkillNames.clear()
}

registerMcpSkillBuilders({
  parseSkillFrontmatterFields,
  createSkillCommand,
})
