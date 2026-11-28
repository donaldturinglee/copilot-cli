/**
 * Component Loader #5: Loads custom Output Styles (`output-styles/*.md`) from
 * enabled plugins.
 */

import type { OutputStyleConfig } from '../../constants/output_styles.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { loadMarkdownConfigDir } from '../markdown_config_loader.js'
import { loadAllPluginsCacheOnly } from './plugin_loader.js'
import {
  loadPluginOptions,
  substitutePluginRootAndData,
  substituteUserConfigInContent,
} from './plugin_options_storage.js'
import type { PluginUserConfigOption } from './schemas.js'

let cachedPluginStyles: Record<string, OutputStyleConfig> | null = null

export function clearPluginOutputStylesCache(): void {
  cachedPluginStyles = null
}

/**
 * Synchronously extracts output styles from an already-loaded plugin array.
 */
export function extractOutputStylesFromPlugins(
  plugins: readonly LoadedPlugin[],
): Record<string, OutputStyleConfig> {
  const styles: Record<string, OutputStyleConfig> = {}
  for (const plugin of plugins) {
    if (plugin.isBuiltin) continue
    const opts = loadPluginOptions(plugin.source)
    const schema = plugin.manifest.userConfig as
      | Record<string, PluginUserConfigOption>
      | undefined
    for (const dir of plugin.outputStylesPaths ?? []) {
      for (const item of loadMarkdownConfigDir(dir)) {
        const shortName =
          typeof item.frontmatter.name === 'string' &&
          item.frontmatter.name.trim()
            ? item.frontmatter.name.trim()
            : item.id
        const namespaced = shortName.includes(':')
          ? shortName
          : `${plugin.name}:${shortName}`
        const prompt = substituteUserConfigInContent(
          substitutePluginRootAndData(item.content, plugin.path, plugin.source),
          opts,
          schema,
        )
        styles[namespaced] = {
          name: namespaced,
          description:
            typeof item.frontmatter.description === 'string'
              ? item.frontmatter.description
              : `Plugin output style from ${plugin.name}`,
          prompt,
          keepCodingInstructions:
            item.frontmatter['keep-coding-instructions'] !== false,
          source: 'project',
        }
      }
    }
  }
  cachedPluginStyles = styles
  return styles
}

/**
 * Loads plugin output styles asynchronously and updates the synchronous cache.
 */
export async function loadPluginOutputStyles(
  pluginsOverride?: readonly LoadedPlugin[],
): Promise<Record<string, OutputStyleConfig>> {
  const enabled = pluginsOverride ?? (await loadAllPluginsCacheOnly()).enabled
  return extractOutputStylesFromPlugins(enabled)
}

/**
 * Returns the latest cached plugin output styles (used by sync `loadOutputStyles()`).
 */
export function getCachedPluginOutputStyles(): Record<string, OutputStyleConfig> {
  return cachedPluginStyles ?? {}
}
