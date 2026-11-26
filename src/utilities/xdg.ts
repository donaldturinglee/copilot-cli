/**
 * XDG Base Directory utilities.
 */

import { homedir as osHomedir } from 'os'
import { join } from 'path'

type EnvLike = Record<string, string | undefined>

type XdgOptions = {
  env?: EnvLike
  homedir?: string
}

function resolveOptions(options?: XdgOptions): { env: EnvLike; home: string } {
  return {
    env: options?.env ?? process.env,
    home: options?.homedir ?? process.env.HOME ?? osHomedir(),
  }
}

export function getXdgStateHome(options?: XdgOptions): string {
  const { env, home } = resolveOptions(options)
  return env.XDG_STATE_HOME ?? join(home, '.local', 'state')
}

export function getXdgCacheHome(options?: XdgOptions): string {
  const { env, home } = resolveOptions(options)
  return env.XDG_CACHE_HOME ?? join(home, '.cache')
}

export function getXdgDataHome(options?: XdgOptions): string {
  const { env, home } = resolveOptions(options)
  return env.XDG_DATA_HOME ?? join(home, '.local', 'share')
}

export function getUserBinDir(options?: XdgOptions): string {
  const { home } = resolveOptions(options)
  return join(home, '.local', 'bin')
}
