import { join } from 'path'
import {
  BUILTIN_OUTPUT_STYLES,
  type OutputStyleConfig,
} from '../constants/output_styles.js'
import { getCwd } from '../utilities/cwd.js'
import { getClaudeConfigHomeDir } from '../utilities/env_utils.js'
import { loadMarkdownConfigDir } from '../utilities/markdown_config_loader.js'

/**
 * Load built-in output styles merged with custom Markdown definitions from
 * `~/.copilot/output-styles/*.md` and `<cwd>/.copilot/output-styles/*.md`.
 */
export function loadOutputStyles(options?: {
  userConfigDir?: string
  projectDir?: string
}): Record<string, OutputStyleConfig> {
  const styles: Record<string, OutputStyleConfig> = { ...BUILTIN_OUTPUT_STYLES }

  const userDir = join(
    options?.userConfigDir ?? getClaudeConfigHomeDir(),
    'output-styles',
  )
  for (const item of loadMarkdownConfigDir(userDir)) {
    const name =
      typeof item.frontmatter.name === 'string' && item.frontmatter.name.trim()
        ? item.frontmatter.name.trim()
        : item.id
    styles[name] = {
      name,
      description:
        typeof item.frontmatter.description === 'string'
          ? item.frontmatter.description
          : `Custom user output style (${item.id})`,
      prompt: item.content,
      keepCodingInstructions: item.frontmatter['keep-coding-instructions'] !== false,
      source: 'user',
    }
  }

  const projectDir = join(
    options?.projectDir ?? getCwd(),
    '.copilot',
    'output-styles',
  )
  for (const item of loadMarkdownConfigDir(projectDir)) {
    const name =
      typeof item.frontmatter.name === 'string' && item.frontmatter.name.trim()
        ? item.frontmatter.name.trim()
        : item.id
    styles[name] = {
      name,
      description:
        typeof item.frontmatter.description === 'string'
          ? item.frontmatter.description
          : `Custom project output style (${item.id})`,
      prompt: item.content,
      keepCodingInstructions: item.frontmatter['keep-coding-instructions'] !== false,
      source: 'project',
    }
  }

  return styles
}
