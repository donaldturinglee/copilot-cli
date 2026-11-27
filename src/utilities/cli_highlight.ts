import { ColorFile } from '../../native/color_diff/index.js'
import type { ThemeName } from './theme.js'

export type HighlightCodeOptions = {
  language?: string
  filePath?: string
  theme?: ThemeName
  width?: number
  dim?: boolean
}

const LANG_EXTENSION_MAP: Record<string, string> = {
  ts: 'ts',
  typescript: 'ts',
  tsx: 'tsx',
  js: 'js',
  javascript: 'js',
  jsx: 'jsx',
  py: 'py',
  python: 'py',
  rs: 'rs',
  rust: 'rs',
  go: 'go',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'md',
  markdown: 'md',
  sql: 'sql',
  css: 'css',
  html: 'html',
  xml: 'xml',
  c: 'c',
  cpp: 'cpp',
  java: 'java',
  rb: 'rb',
  ruby: 'rb',
  toml: 'toml',
}

/**
 * Syntax-highlight a source snippet into ANSI-escaped lines using the lazy-loaded
 * pure-TS ColorFile engine (zero startup overhead when unused).
 */
export function highlightCodeToLines(
  code: string,
  options: HighlightCodeOptions = {},
): string[] {
  const ext = options.language
    ? (LANG_EXTENSION_MAP[options.language.toLowerCase()] ?? options.language.toLowerCase())
    : ''
  const virtualPath = options.filePath ?? (ext ? `snippet.${ext}` : 'snippet.txt')
  const theme = options.theme ?? 'dark'
  const width = Math.max(20, options.width ?? 120)
  const dim = options.dim ?? false

  const file = new ColorFile(code, virtualPath)
  const rendered = file.render(theme, width, dim)
  return rendered ?? code.split('\n')
}

export function highlightCode(
  code: string,
  options: HighlightCodeOptions = {},
): string {
  return highlightCodeToLines(code, options).join('\n')
}
