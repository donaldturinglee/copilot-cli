/**
 * Component Loaders #1 & #2: Loads namespaced Slash Commands (`commands/`,
 * `commandsMetadata`) and Skills (`skills/<name>/SKILL.md`, builtin plugin
 * skills) from enabled plugins with `${COPILOT_PLUGIN_ROOT}`,
 * `${COPILOT_PLUGIN_DATA}`, and redacted `${user_config.KEY}` substitution.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, dirname, extname, join, relative } from 'path'
import { getBuiltinPlugins } from '../../plugins/builtin_plugins.js'
import { bundledSkillToCommand } from '../../skills/bundled_skills.js'
import { createSkillCommand } from '../../skills/load_skills_dir.js'
import type { Command } from '../../types/command.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { parseFrontmatter } from '../frontmatter_parser.js'
import { resolvePathWithinPlugin } from './plugin_directories.js'
import { loadAllPluginsCacheOnly } from './plugin_loader.js'
import {
  loadPluginOptions,
  substitutePluginRootAndData,
  substituteUserConfigInContent,
} from './plugin_options_storage.js'
import type { PluginUserConfigOption } from './schemas.js'

let cachedPluginCommands: Command[] | null = null

/**
 * Clears cached plugin commands and skills.
 */
export function clearPluginCommandCache(): void {
  cachedPluginCommands = null
}

function walkCommandMarkdownFiles(
  rootDir: string,
  currentDir: string = rootDir,
): Array<{ filePath: string; relNamespace: string; baseName: string }> {
  if (!existsSync(currentDir)) {
    return []
  }
  const st = statSync(currentDir)
  if (st.isFile() && extname(currentDir).toLowerCase() === '.md') {
    return [
      {
        filePath: currentDir,
        relNamespace: '',
        baseName: basename(currentDir, extname(currentDir)),
      },
    ]
  }

  let entries
  try {
    entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
  } catch {
    return []
  }

  // Stop at skill directories containing `SKILL.md` so skills aren't double-loaded
  if (
    currentDir !== rootDir &&
    entries.some(e => e.isFile() && e.name === 'SKILL.md')
  ) {
    return []
  }

  const out: Array<{
    filePath: string
    relNamespace: string
    baseName: string
  }> = []
  for (const entry of entries) {
    const full = join(currentDir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkCommandMarkdownFiles(rootDir, full))
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      const relDir = relative(rootDir, dirname(full)).replace(/\\/g, '/')
      out.push({
        filePath: full,
        relNamespace: relDir === '.' ? '' : relDir.split('/').filter(Boolean).join(':'),
        baseName: basename(entry.name, extname(entry.name)),
      })
    }
  }
  return out
}

function loadCommandsAndSkillsForSinglePlugin(plugin: LoadedPlugin): Command[] {
  const results: Command[] = []

  if (plugin.isBuiltin) {
    const def = getBuiltinPlugins().find(b => b.name === plugin.name)
    for (const skillDef of def?.skills ?? []) {
      results.push(bundledSkillToCommand(skillDef))
    }
    return results
  }

  const userOptions = loadPluginOptions(plugin.source)
  const userConfigSchema = plugin.manifest.userConfig as
    | Record<string, PluginUserConfigOption>
    | undefined

  const preprocessMarkdown = (rawContent: string): string => {
    const withPaths = substitutePluginRootAndData(
      rawContent,
      plugin.path,
      plugin.source,
    )
    return substituteUserConfigInContent(
      withPaths,
      userOptions,
      userConfigSchema,
    )
  }

  // 1. Directory/path commands
  for (const cmdRoot of plugin.commandsPaths ?? []) {
    for (const file of walkCommandMarkdownFiles(cmdRoot)) {
      try {
        const parsed = parseFrontmatter(
          readFileSync(file.filePath, 'utf8'),
          file.filePath,
        )
        const qualifiedName = file.relNamespace
          ? `${plugin.name}:${file.relNamespace}:${file.baseName}`
          : `${plugin.name}:${file.baseName}`
        results.push(
          createSkillCommand({
            name: qualifiedName,
            markdownContent: preprocessMarkdown(parsed.content.trim()),
            frontmatter: parsed.frontmatter,
            source: 'plugin',
            loadedFrom: 'plugin',
            baseDir: dirname(file.filePath),
            filePath: file.filePath,
            pluginInfo: {
              pluginManifest: plugin.manifest,
              repository: plugin.repository,
            },
          }),
        )
      } catch {
        // Ignore unreadable command markdown
      }
    }
  }

  // 2. Inline `commandsMetadata` record
  if (plugin.commandsMetadata) {
    for (const [cmdKey, meta] of Object.entries(plugin.commandsMetadata)) {
      let markdownBody = meta.content ?? ''
      let frontmatter = {}
      let baseDir = plugin.path
      if (meta.source) {
        const srcPath = resolvePathWithinPlugin(plugin.path, meta.source)
        if (!srcPath || !existsSync(srcPath)) {
          continue
        }
        const parsed = parseFrontmatter(readFileSync(srcPath, 'utf8'), srcPath)
        markdownBody = parsed.content.trim()
        frontmatter = parsed.frontmatter
        baseDir = dirname(srcPath)
      }
      const qualifiedName = cmdKey.includes(':')
        ? cmdKey
        : `${plugin.name}:${cmdKey}`
      results.push(
        createSkillCommand({
          name: qualifiedName,
          markdownContent: preprocessMarkdown(markdownBody),
          frontmatter: {
            ...frontmatter,
            ...(meta.description ? { description: meta.description } : {}),
            ...(meta.argumentHint ? { 'argument-hint': meta.argumentHint } : {}),
            ...(meta.model ? { model: meta.model } : {}),
            ...(meta.allowedTools ? { 'allowed-tools': meta.allowedTools } : {}),
          },
          source: 'plugin',
          loadedFrom: 'plugin',
          baseDir,
          pluginInfo: {
            pluginManifest: plugin.manifest,
            repository: plugin.repository,
          },
        }),
      )
    }
  }

  // 3. Plugin Skills (`<skillsPath>/SKILL.md` or `<skillsPath>/<name>/SKILL.md`)
  for (const skillsRoot of plugin.skillsPaths ?? []) {
    if (!existsSync(skillsRoot)) continue
    const directSkill = join(skillsRoot, 'SKILL.md')
    if (existsSync(directSkill)) {
      const parsed = parseFrontmatter(
        readFileSync(directSkill, 'utf8'),
        directSkill,
      )
      const folderName = basename(skillsRoot)
      results.push(
        createSkillCommand({
          name: `${plugin.name}:${folderName}`,
          markdownContent: preprocessMarkdown(parsed.content.trim()),
          frontmatter: parsed.frontmatter,
          source: 'plugin',
          loadedFrom: 'plugin',
          baseDir: skillsRoot,
          filePath: directSkill,
          pluginInfo: {
            pluginManifest: plugin.manifest,
            repository: plugin.repository,
          },
        }),
      )
      continue
    }

    try {
      for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        const subDir = join(skillsRoot, entry.name)
        const skillFile = join(subDir, 'SKILL.md')
        if (!existsSync(skillFile)) continue
        const parsed = parseFrontmatter(
          readFileSync(skillFile, 'utf8'),
          skillFile,
        )
        const explicitName =
          typeof parsed.frontmatter.name === 'string' &&
          parsed.frontmatter.name.trim()
            ? parsed.frontmatter.name.trim()
            : entry.name
        const namespacedName = explicitName.includes(':')
          ? explicitName
          : `${plugin.name}:${explicitName}`
        results.push(
          createSkillCommand({
            name: namespacedName,
            markdownContent: preprocessMarkdown(parsed.content.trim()),
            frontmatter: {
              ...parsed.frontmatter,
              name: namespacedName,
            },
            source: 'plugin',
            loadedFrom: 'plugin',
            baseDir: subDir,
            filePath: skillFile,
            pluginInfo: {
              pluginManifest: plugin.manifest,
              repository: plugin.repository,
            },
          }),
        )
      }
    } catch {
      // Ignore unreadable skills directory
    }
  }

  return results
}

/**
 * Loads all commands and skills from currently enabled plugins.
 */
export async function getPluginCommands(
  pluginsOverride?: readonly LoadedPlugin[],
): Promise<Command[]> {
  if (!pluginsOverride && cachedPluginCommands) {
    return cachedPluginCommands
  }
  const enabledPlugins =
    pluginsOverride ?? (await loadAllPluginsCacheOnly()).enabled
  const commands: Command[] = []
  for (const plugin of enabledPlugins) {
    commands.push(...loadCommandsAndSkillsForSinglePlugin(plugin))
  }
  if (!pluginsOverride) {
    cachedPluginCommands = commands
  }
  return commands
}
