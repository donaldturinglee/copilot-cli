import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import { getPlatform } from '../platform.js'

export const getManagedFilePath = memoize((): string => {
  switch (getPlatform()) {
    case 'macos':
      return '/Library/Application Support/ClaudeCode'
    case 'windows':
      return 'C:\\Program Files\\ClaudeCode'
    default:
      return '/etc/claude-code'
  }
})

export const getManagedSettingsDropInDir = memoize((): string => {
  return join(getManagedFilePath(), 'managed-settings.d')
})
