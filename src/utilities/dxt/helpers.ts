/**
 * Lazy-loaded `@anthropic-ai/mcpb/browser` helpers and cross-platform user
 * directory resolvers for `.mcpb` / `.dxt` Desktop Extension bundles.
 *
 * Imports `@anthropic-ai/mcpb/browser` rather than the top-level CLI/signing
 * barrel so `node-forge`, `@inquirer/prompts`, and `galactus` are never loaded.
 */

import { homedir, tmpdir } from 'os'
import { join } from 'path'

export interface SystemDirectoriesMap {
  home: string
  desktop: string
  documents: string
  downloads: string
  temp: string
}

/**
 * Returns standard user directories substituted into MCPB `${user_config}` /
 * manifest templates.
 */
export function getSystemDirectories(): SystemDirectoriesMap {
  const home = homedir()
  return {
    home,
    desktop: join(home, 'Desktop'),
    documents: join(home, 'Documents'),
    downloads: join(home, 'Downloads'),
    temp: tmpdir(),
  }
}

let cachedMcpbPromise: Promise<typeof import('@anthropic-ai/mcpb/browser')> | null =
  null

/**
 * Lazily imports `@anthropic-ai/mcpb/browser` only when a `.mcpb` or `.dxt`
 * bundle is encountered.
 */
export function loadMcpbModule(): Promise<
  typeof import('@anthropic-ai/mcpb/browser')
> {
  if (!cachedMcpbPromise) {
    cachedMcpbPromise = import('@anthropic-ai/mcpb/browser')
  }
  return cachedMcpbPromise
}
