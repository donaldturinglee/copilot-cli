/**
 * Bundled skills registry and symlink-safe disk extractor (`O_NOFOLLOW | O_EXCL`
 * on POSIX, `'wx'` on Windows, mode `0o700` dirs / `0o600` files) for skills
 * declaring static `files`.
 */

import { randomBytes } from 'crypto'
import { constants as fsConstants } from 'fs'
import { mkdir, open } from 'fs/promises'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'path'
import type { Command } from '../types/command.js'
import type { BundledSkillDefinition } from '../types/forward.js'
import { getCopilotTempDir } from '../utilities/permissions/filesystem.js'

const registeredBundledSkills = new Map<string, BundledSkillDefinition>()
const extractionPromises = new Map<string, Promise<string | null>>()
let bundledSessionRoot: string | null = null

function getMacroVersion(): string {
  const macroGlobal = (
    globalThis as unknown as { MACRO?: { VERSION?: string } }
  ).MACRO
  return macroGlobal?.VERSION ?? '0.0.1'
}

/**
 * Returns the per-process high-entropy temporary directory used for extracted
 * bundled skill files (`<copilotTempDir>/bundled-skills/<version>/<128-bit-hex>`).
 */
export function getBundledSkillsRoot(): string {
  if (!bundledSessionRoot) {
    const nonce = randomBytes(16).toString('hex')
    bundledSessionRoot = join(
      getCopilotTempDir(),
      'bundled-skills',
      getMacroVersion(),
      nonce,
    )
  }
  return bundledSessionRoot
}

/**
 * Resolves `relPath` strictly inside `baseDir`, rejecting absolute paths and
 * `..` directory traversal segments.
 */
export function resolveSkillFilePath(baseDir: string, relPath: string): string {
  const normalized = normalize(relPath)
  if (isAbsolute(normalized)) {
    throw new Error(`Invalid absolute bundled skill file path: ${relPath}`)
  }
  const segments = normalized.split(/[\\/]+/)
  if (segments.includes('..')) {
    throw new Error(`Bundled skill file path traversal rejected: ${relPath}`)
  }
  const resolvedBase = resolve(baseDir)
  const target = resolve(resolvedBase, normalized)
  if (target !== resolvedBase && !target.startsWith(`${resolvedBase}${sep}`)) {
    throw new Error(`Bundled skill file escaped base directory: ${relPath}`)
  }
  return target
}

async function safeWriteSkillFile(
  targetPath: string,
  content: string,
): Promise<void> {
  const flags =
    process.platform === 'win32'
      ? 'wx'
      : fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0)
  const handle = await open(targetPath, flags, 0o600)
  try {
    await handle.writeFile(content, 'utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Atomically extracts static `files` for a bundled skill once per process.
 */
export async function extractBundledSkillFiles(
  skillName: string,
  files: Readonly<Record<string, string>>,
): Promise<string | null> {
  const existing = extractionPromises.get(skillName)
  if (existing) {
    return existing
  }

  const promise = (async (): Promise<string | null> => {
    try {
      const safeName = skillName.replace(/[^a-zA-Z0-9_-]/g, '_')
      const skillDir = join(getBundledSkillsRoot(), safeName)
      await mkdir(skillDir, { recursive: true, mode: 0o700 })

      const parentDirs = new Set<string>()
      const targets: Array<{ path: string; content: string }> = []
      for (const [relPath, content] of Object.entries(files)) {
        const target = resolveSkillFilePath(skillDir, relPath)
        parentDirs.add(dirname(target))
        targets.push({ path: target, content })
      }

      for (const dir of parentDirs) {
        await mkdir(dir, { recursive: true, mode: 0o700 })
      }
      for (const item of targets) {
        await safeWriteSkillFile(item.path, item.content)
      }
      return skillDir
    } catch {
      return null
    }
  })()

  extractionPromises.set(skillName, promise)
  return promise
}

/**
 * Converts a `BundledSkillDefinition` into an executable prompt `Command`.
 */
export function bundledSkillToCommand(def: BundledSkillDefinition): Command {
  const userInvocable = def.userInvocable ?? true
  return {
    type: 'prompt',
    name: def.name,
    aliases: def.aliases,
    description: def.description,
    hasUserSpecifiedDescription: true,
    whenToUse: def.whenToUse,
    argumentHint: def.argumentHint,
    allowedTools: def.allowedTools,
    model: def.model,
    disableModelInvocation: def.disableModelInvocation,
    userInvocable,
    isHidden: !userInvocable,
    isEnabled: def.isEnabled,
    hooks: def.hooks,
    context: def.context,
    agent: def.agent,
    loadedFrom: 'bundled',
    source: 'bundled',
    progressMessage: `Running ${def.name}…`,
    contentLength: def.description.length,
    async getPromptForCommand(args, context) {
      const blocks = await def.getPromptForCommand(args, context)
      if (!def.files || Object.keys(def.files).length === 0) {
        return blocks
      }
      const extractedDir = await extractBundledSkillFiles(def.name, def.files)
      if (!extractedDir || blocks.length === 0) {
        return blocks
      }
      const first = blocks[0]
      if (first && first.type === 'text') {
        return [
          {
            type: 'text',
            text: `Base directory for this skill: ${extractedDir}\n\n${first.text}`,
          },
          ...blocks.slice(1),
        ]
      }
      return [
        { type: 'text', text: `Base directory for this skill: ${extractedDir}` },
        ...blocks,
      ]
    },
  }
}

/**
 * Registers a bundled skill into the process registry.
 */
export function registerBundledSkill(def: BundledSkillDefinition): void {
  registeredBundledSkills.set(def.name, def)
}

/**
 * Returns all registered bundled skills converted to `Command[]`.
 */
export function getBundledSkillCommands(): Command[] {
  return Array.from(registeredBundledSkills.values()).map(bundledSkillToCommand)
}

/**
 * Resets registered bundled skills and extraction state (test helper).
 */
export function clearBundledSkillsForTesting(): void {
  registeredBundledSkills.clear()
  extractionPromises.clear()
  bundledSessionRoot = null
}
