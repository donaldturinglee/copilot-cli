import { LRUCache } from 'lru-cache'
import { Lexer, type Token, type Tokens, type TokensList } from 'marked'
import React, { memo, useMemo, useRef } from 'react'
import { BLOCKQUOTE_BAR } from '../constants/figures.js'
import { Box } from '../ink/components/box.js'
import { Link } from '../ink/components/link.js'
import { Text } from '../ink/components/text.js'
import { hashContent } from '../utilities/hash.js'
import { Divider } from './design_system/divider.js'
import { ThemedText } from './design_system/themed_text.js'
import { HighlightedCode } from './highlighted_code.js'
import { MarkdownTable } from './markdown_table.js'

// Fast-path regex: if none of these markdown characters appear, skip `marked` completely
const MD_SYNTAX_RE = /[*_`#[\]()>|~\\-]|^\d+\./m

// 500-entry hash-keyed LRU cache for parsed marked TokenLists
const LEXER_CACHE = new LRUCache<string, TokensList>({ max: 500 })

export function cachedLexer(markdown: string): TokensList {
  const key = `${markdown.length}:${hashContent(markdown)}`
  const hit = LEXER_CACHE.get(key)
  if (hit) return hit
  const tokens = Lexer.lex(markdown)
  LEXER_CACHE.set(key, tokens)
  return tokens
}

export function getMarkdownCacheSize(): number {
  return LEXER_CACHE.size
}

export function clearMarkdownCache(): void {
  LEXER_CACHE.clear()
}

function renderInline(tokens: Token[] | undefined): React.ReactNode {
  if (!tokens || tokens.length === 0) return null
  return tokens.map((token, idx) => {
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text
        return (
          <React.Fragment key={idx}>
            {t.tokens ? renderInline(t.tokens) : t.text}
          </React.Fragment>
        )
      }
      case 'strong': {
        const t = token as Tokens.Strong
        return (
          <Text key={idx} bold>
            {renderInline(t.tokens)}
          </Text>
        )
      }
      case 'em': {
        const t = token as Tokens.Em
        return (
          <Text key={idx} italic>
            {renderInline(t.tokens)}
          </Text>
        )
      }
      case 'del': {
        const t = token as Tokens.Del
        return (
          <Text key={idx} strikethrough dimColor>
            {renderInline(t.tokens)}
          </Text>
        )
      }
      case 'codespan': {
        const t = token as Tokens.Codespan
        return (
          <ThemedText key={idx} color="suggestion">
            {t.text}
          </ThemedText>
        )
      }
      case 'link': {
        const t = token as Tokens.Link
        return (
          <Link key={idx} url={t.href}>
            {renderInline(t.tokens) || t.text}
          </Link>
        )
      }
      case 'br':
        return <Text key={idx}>{'\n'}</Text>
      case 'escape':
        return (
          <React.Fragment key={idx}>
            {(token as Tokens.Escape).text}
          </React.Fragment>
        )
      default:
        return <React.Fragment key={idx}>{token.raw ?? ''}</React.Fragment>
    }
  })
}

function extractPlainText(tokens: Token[] | undefined): string {
  if (!tokens) return ''
  return tokens
    .map(t => {
      if ('tokens' in t && Array.isArray(t.tokens)) {
        return extractPlainText(t.tokens as Token[])
      }
      if ('text' in t && typeof t.text === 'string') return t.text
      return t.raw ?? ''
    })
    .join('')
}

function renderBlock(token: Token, key: number, width: number): React.ReactNode {
  switch (token.type) {
    case 'space':
      return null

    case 'heading': {
      const h = token as Tokens.Heading
      return (
        <Box key={key} marginBottom={0}>
          <ThemedText
            bold
            underline={h.depth === 1}
            color={h.depth <= 2 ? 'claude' : 'text'}
          >
            {renderInline(h.tokens)}
          </ThemedText>
        </Box>
      )
    }

    case 'paragraph': {
      const p = token as Tokens.Paragraph
      return (
        <Box key={key}>
          <Text>{renderInline(p.tokens)}</Text>
        </Box>
      )
    }

    case 'code': {
      const c = token as Tokens.Code
      return (
        <Box key={key} flexDirection="column" marginY={0}>
          {c.lang ? <ThemedText dimColor>{c.lang}</ThemedText> : null}
          <HighlightedCode code={c.text} language={c.lang} width={width} />
        </Box>
      )
    }

    case 'blockquote': {
      const bq = token as Tokens.Blockquote
      return (
        <Box key={key} flexDirection="row" gap={1}>
          <ThemedText color="subtle">{BLOCKQUOTE_BAR}</ThemedText>
          <Box flexDirection="column" flexGrow={1}>
            {bq.tokens.map((inner, idx) =>
              renderBlock(inner, idx, Math.max(10, width - 2)),
            )}
          </Box>
        </Box>
      )
    }

    case 'list': {
      const list = token as Tokens.List
      const start = Number(list.start || 1)
      return (
        <Box key={key} flexDirection="column">
          {list.items.map((item, idx) => (
            <Box key={idx} flexDirection="row" gap={1}>
              <ThemedText dimColor>
                {list.ordered ? `${start + idx}.` : '•'}
              </ThemedText>
              <Box flexDirection="column" flexGrow={1}>
                {item.tokens.map((t, ti) =>
                  t.type === 'text' ? (
                    <Text key={ti}>
                      {renderInline((t as Tokens.Text).tokens) ??
                        (t as Tokens.Text).text}
                    </Text>
                  ) : (
                    renderBlock(t, ti, Math.max(10, width - 3))
                  ),
                )}
              </Box>
            </Box>
          ))}
        </Box>
      )
    }

    case 'table': {
      const tbl = token as Tokens.Table
      const headers = tbl.header.map(cell =>
        extractPlainText(cell.tokens) || cell.text,
      )
      const rows = tbl.rows.map(row =>
        row.map(cell => extractPlainText(cell.tokens) || cell.text),
      )
      return (
        <Box key={key}>
          <MarkdownTable
            headers={headers}
            rows={rows}
            align={tbl.align}
            maxWidth={width}
          />
        </Box>
      )
    }

    case 'hr':
      return <Divider key={key} width={Math.min(width, 60)} />

    default:
      return (
        <Box key={key}>
          <Text>{token.raw ?? ''}</Text>
        </Box>
      )
  }
}

export type MarkdownProps = {
  children: string
  width?: number
}

export const Markdown = memo(function Markdown({
  children,
  width = 80,
}: MarkdownProps): React.ReactNode {
  const trimmed = children ?? ''
  if (trimmed.length === 0) return null

  // Fast path: pure prose without markdown syntax skips lexer entirely
  if (!MD_SYNTAX_RE.test(trimmed)) {
    return (
      <Box flexDirection="column">
        <Text>{trimmed}</Text>
      </Box>
    )
  }

  const tokens = useMemo(() => cachedLexer(trimmed), [trimmed])

  return (
    <Box flexDirection="column" gap={1}>
      {tokens.map((token, idx) => renderBlock(token, idx, width))}
    </Box>
  )
})

/**
 * Find the largest safe split index ending on a blank-line boundary outside
 * any open fenced code block (` ``` ` or `~~~`).
 */
export function findStableMarkdownBoundary(text: string): number {
  const lines = text.split('\n')
  let inFence = false
  let fenceChar = ''
  let offset = 0
  let lastSafeBoundary = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trimStart()
    if (!inFence && (trimmed.startsWith('```') || trimmed.startsWith('~~~'))) {
      inFence = true
      fenceChar = trimmed.slice(0, 3)
    } else if (inFence && trimmed.startsWith(fenceChar)) {
      inFence = false
      fenceChar = ''
    }

    offset += line.length + (i < lines.length - 1 ? 1 : 0)

    if (!inFence && line.trim() === '' && i < lines.length - 1) {
      lastSafeBoundary = offset
    }
  }

  return lastSafeBoundary
}

export type StreamingMarkdownProps = {
  children: string
  width?: number
  isStreaming?: boolean
}

/**
 * Streaming-optimized Markdown renderer with a monotonic `stablePrefixRef`.
 * Completed blocks are frozen in a memoized `<Markdown>` subtree while only
 * the live tail re-lexes as new tokens arrive.
 */
export function StreamingMarkdown({
  children,
  width = 80,
  isStreaming = true,
}: StreamingMarkdownProps): React.ReactNode {
  const stablePrefixRef = useRef('')

  if (!isStreaming) {
    stablePrefixRef.current = ''
    return <Markdown width={width}>{children}</Markdown>
  }

  // Reset monotonic prefix if stream restarted with different content
  if (!children.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = ''
  }

  const boundary = findStableMarkdownBoundary(children)
  if (boundary > stablePrefixRef.current.length) {
    stablePrefixRef.current = children.slice(0, boundary)
  }

  const stablePrefix = stablePrefixRef.current
  const liveTail = children.slice(stablePrefix.length)

  return (
    <Box flexDirection="column" gap={1}>
      {stablePrefix.length > 0 ? (
        <Markdown width={width}>{stablePrefix}</Markdown>
      ) : null}
      {liveTail.length > 0 ? <Markdown width={width}>{liveTail}</Markdown> : null}
    </Box>
  )
}
