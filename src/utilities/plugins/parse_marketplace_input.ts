/**
 * Shorthand CLI / slash-command input parser for marketplace sources
 * (`owner/repo`, `owner/repo#ref`, `https://.../marketplace.json`, `git@...`,
 * local directory, or local `.json` file).
 */

import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { extname, resolve } from 'path'
import { getCwd } from '../cwd.js'
import type { MarketplaceSource } from './schemas.js'

function expandTilde(raw: string): string {
  if (raw === '~') {
    return homedir()
  }
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return resolve(homedir(), raw.slice(2))
  }
  return raw
}

/**
 * Parses user-supplied marketplace specifier `raw` into a typed `MarketplaceSource`.
 */
export function parseMarketplaceInput(
  raw: string,
  sparsePaths?: string[],
): MarketplaceSource {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('Marketplace source cannot be empty')
  }

  // Local path check first (./, ../, /, ~, Windows C:\, or existing path on disk)
  const expanded = expandTilde(trimmed)
  const isExplicitPath =
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('.\\') ||
    trimmed.startsWith('..\\') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('~') ||
    /^[a-zA-Z]:[\\/]/.test(trimmed)

  const candidateAbs = resolve(getCwd(), expanded)
  if (isExplicitPath || existsSync(candidateAbs)) {
    if (
      extname(candidateAbs).toLowerCase() === '.json' &&
      (!existsSync(candidateAbs) || statSync(candidateAbs).isFile())
    ) {
      return { source: 'file', path: candidateAbs }
    }
    return { source: 'directory', path: candidateAbs }
  }

  // Direct remote JSON URL
  if (
    (trimmed.startsWith('https://') || trimmed.startsWith('http://')) &&
    trimmed.split('?')[0]!.toLowerCase().endsWith('.json')
  ) {
    return { source: 'url', url: trimmed }
  }

  // Git URL (SSH git@..., .git suffix, Azure DevOps /_git/, HTTP git repo)
  if (
    trimmed.startsWith('git@') ||
    trimmed.startsWith('ssh://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://')
  ) {
    const hashIdx = trimmed.indexOf('#')
    const url = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx)
    const ref = hashIdx === -1 ? undefined : trimmed.slice(hashIdx + 1)
    return {
      source: 'git',
      url,
      ...(ref ? { ref } : {}),
      ...(sparsePaths?.length ? { sparsePaths } : {}),
    }
  }

  // npm:<pkg> shorthand
  if (trimmed.startsWith('npm:')) {
    return { source: 'npm', package: trimmed.slice(4) }
  }

  // GitHub `owner/repo` or `owner/repo#ref`
  if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+(?:#[^\s]+)?$/.test(trimmed)) {
    const hashIdx = trimmed.indexOf('#')
    const repo = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx)
    const ref = hashIdx === -1 ? undefined : trimmed.slice(hashIdx + 1)
    return {
      source: 'github',
      repo,
      ...(ref ? { ref } : {}),
      ...(sparsePaths?.length ? { sparsePaths } : {}),
    }
  }

  throw new Error(
    `Unrecognized marketplace source "${trimmed}". Provide a local directory, marketplace.json URL, git URL, or GitHub owner/repo.`,
  )
}
