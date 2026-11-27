import chalk from 'chalk'
import { Lexer, type Token, type Tokens } from 'marked'
import { BLOCKQUOTE_BAR } from '../constants/figures.js'
import { highlightCode } from './cli_highlight.js'
import { createHyperlink } from './hyperlink.js'
import type { ThemeName } from './theme.js'

export type FormatMarkdownOptions = {
  theme?: ThemeName
  width?: number
  enableCodeHighlight?: boolean
}

function renderInlineTokens(tokens: Token[] | undefined): string {
  if (!tokens || tokens.length === 0) return ''
  let out = ''
  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text
        out += t.tokens ? renderInlineTokens(t.tokens) : t.text
        break
      }
      case 'strong': {
        const t = token as Tokens.Strong
        out += chalk.bold(renderInlineTokens(t.tokens))
        break
      }
      case 'em': {
        const t = token as Tokens.Em
        out += chalk.italic(renderInlineTokens(t.tokens))
        break
      }
      case 'del': {
        const t = token as Tokens.Del
        out += chalk.strikethrough(renderInlineTokens(t.tokens))
        break
      }
      case 'codespan': {
        const t = token as Tokens.Codespan
        out += chalk.cyan(t.text)
        break
      }
      case 'link': {
        const t = token as Tokens.Link
        const label = renderInlineTokens(t.tokens) || t.text
        out += chalk.underline.blue(createHyperlink(t.href, label))
        break
      }
      case 'br':
        out += '\n'
        break
      case 'escape':
        out += (token as Tokens.Escape).text
        break
      default:
        out += token.raw ?? ''
        break
    }
  }
  return out
}

function renderToken(token: Token, options: FormatMarkdownOptions, indent = ''): string {
  switch (token.type) {
    case 'space':
      return ''
    case 'heading': {
      const h = token as Tokens.Heading
      const text = renderInlineTokens(h.tokens)
      if (h.depth === 1) return chalk.bold.underline(text) + '\n'
      if (h.depth === 2) return chalk.bold(text) + '\n'
      return chalk.bold.dim(text) + '\n'
    }
    case 'paragraph': {
      const p = token as Tokens.Paragraph
      return indent + renderInlineTokens(p.tokens) + '\n'
    }
    case 'code': {
      const c = token as Tokens.Code
      const body =
        options.enableCodeHighlight !== false
          ? highlightCode(c.text, {
              language: c.lang,
              theme: options.theme,
              width: options.width,
            })
          : c.text
      return body + '\n'
    }
    case 'blockquote': {
      const bq = token as Tokens.Blockquote
      const inner = bq.tokens
        .map(t => renderToken(t, options, ''))
        .join('')
        .trimEnd()
      return (
        inner
          .split('\n')
          .map(line => `${indent}${chalk.dim(BLOCKQUOTE_BAR)} ${chalk.dim(line)}`)
          .join('\n') + '\n'
      )
    }
    case 'list': {
      const list = token as Tokens.List
      return (
        list.items
          .map((item, idx) => {
            const marker = list.ordered
              ? `${Number(list.start || 1) + idx}.`
              : '•'
            const content = item.tokens
              .map(t => renderToken(t, options, indent + '  '))
              .join('')
              .trim()
            return `${indent}${marker} ${content}`
          })
          .join('\n') + '\n'
      )
    }
    case 'hr': {
      const width = Math.max(10, Math.min(options.width ?? 60, 80))
      return chalk.dim('─'.repeat(width)) + '\n'
    }
    case 'text': {
      const t = token as Tokens.Text
      return indent + (t.tokens ? renderInlineTokens(t.tokens) : t.text)
    }
    default:
      return token.raw ?? ''
  }
}

/**
 * Format a Markdown document to ANSI-styled terminal text.
 */
export function formatMarkdownToAnsi(
  markdown: string,
  options: FormatMarkdownOptions = {},
): string {
  if (!markdown) return ''
  const tokens = Lexer.lex(markdown)
  return tokens
    .map(t => renderToken(t, options))
    .filter(Boolean)
    .join('\n')
    .trimEnd()
}
