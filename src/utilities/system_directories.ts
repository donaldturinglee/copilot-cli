import { homedir as osHomedir } from 'os'
import { join } from 'path'
import { logForDebugging } from './debug.js'
import { getPlatform, type Platform } from './platform.js'

export type SystemDirectories = {
  home: string
  desktop: string
  documents: string
  downloads: string
  [key: string]: string
}

export function getSystemDirectories(options?: {
  env?: Record<string, string | undefined>
  homedir?: string
  platform?: Platform
}): SystemDirectories {
  const env = options?.env ?? process.env
  const homeDir = options?.homedir ?? osHomedir()
  const platform = options?.platform ?? getPlatform()

  const defaults: SystemDirectories = {
    home: homeDir,
    desktop: join(homeDir, 'Desktop'),
    documents: join(homeDir, 'Documents'),
    downloads: join(homeDir, 'Downloads'),
  }

  if (platform === 'windows') {
    const profileDir = env.USERPROFILE || homeDir
    return {
      home: homeDir,
      desktop: join(profileDir, 'Desktop'),
      documents: join(profileDir, 'Documents'),
      downloads: join(profileDir, 'Downloads'),
    }
  }

  if (platform === 'linux' || platform === 'wsl') {
    return {
      home: homeDir,
      desktop: env.XDG_DESKTOP_DIR || defaults.desktop,
      documents: env.XDG_DOCUMENTS_DIR || defaults.documents,
      downloads: env.XDG_DOWNLOAD_DIR || defaults.downloads,
    }
  }

  if (platform === 'unknown') {
    logForDebugging(
      'Unknown platform when resolving system directories; using defaults',
    )
  }

  return defaults
}
