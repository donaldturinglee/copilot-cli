import React from 'react'
import { Link } from '../ink/components/link.js'
import { ThemedText } from './design_system/themed_text.js'

export type FilePathLinkProps = {
  filePath: string
  line?: number
  label?: string
}

export function FilePathLink({
  filePath,
  line,
  label,
}: FilePathLinkProps): React.ReactNode {
  const normalized = filePath.replace(/\\/g, '/')
  const url = `file://${normalized.startsWith('/') ? '' : '/'}${normalized}${line ? `:${line}` : ''}`
  const display = label ?? (line ? `${filePath}:${line}` : filePath)
  return (
    <Link url={url}>
      <ThemedText color="suggestion">{display}</ThemedText>
    </Link>
  )
}
