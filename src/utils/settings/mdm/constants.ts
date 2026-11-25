import { userInfo } from 'os'
import { join } from 'path'

export const MACOS_PREFERENCE_DOMAIN = 'com.anthropic.claudecode'
export const WINDOWS_REGISTRY_KEY_PATH_HKLM =
  'HKLM\\SOFTWARE\\Policies\\ClaudeCode'
export const WINDOWS_REGISTRY_KEY_PATH_HKCU =
  'HKCU\\SOFTWARE\\Policies\\ClaudeCode'
export const WINDOWS_REGISTRY_VALUE_NAME = 'Settings'
export const PLUTIL_PATH = '/usr/bin/plutil'
export const PLUTIL_ARGS_PREFIX = ['-convert', 'json', '-o', '-', '--'] as const
export const MDM_SUBPROCESS_TIMEOUT_MS = 5000

export function getMacosPlistPaths(): Array<{ path: string; label: string }> {
  const paths: Array<{ path: string; label: string }> = []
  try {
    const username = userInfo().username
    if (username) {
      paths.push({
        path: join(
          '/Library/Managed Preferences',
          username,
          `${MACOS_PREFERENCE_DOMAIN}.plist`,
        ),
        label: 'macOS per-user managed preferences',
      })
    }
  } catch {
    // userInfo may fail in minimal containers
  }

  paths.push({
    path: join(
      '/Library/Managed Preferences',
      `${MACOS_PREFERENCE_DOMAIN}.plist`,
    ),
    label: 'macOS device managed preferences',
  })

  return paths
}
