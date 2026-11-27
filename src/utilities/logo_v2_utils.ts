import { homedir } from 'os'

export type LogoHeaderInfo = {
  version: string
  modelLabel: string
  cwdDisplay: string
  modeLabel: string
  tips: string[]
}

export function shortenHomePath(pathStr: string): string {
  const home = homedir()
  if (home && pathStr.startsWith(home)) {
    return '~' + pathStr.slice(home.length)
  }
  return pathStr
}

export function getLogoTips(isNewUser: boolean): string[] {
  if (isNewUser) {
    return [
      'Type /help for available commands',
      'Use @filename to reference project files',
      'Prefix with ! to run a shell command directly',
      'Press Shift+Tab to cycle permission modes',
    ]
  }
  return [
    'Use /diff to inspect workspace changes',
    'Press Ctrl+R to search prompt history',
    'Press Ctrl+O to toggle full transcript view',
  ]
}

export function buildLogoHeaderInfo(options: {
  version?: string
  model?: string | null
  cwd: string
  permissionMode?: string
  isNewUser?: boolean
}): LogoHeaderInfo {
  const macroVersion =
    (globalThis as unknown as { MACRO?: { VERSION?: string } }).MACRO
      ?.VERSION ?? '0.1.0'
  return {
    version: options.version ?? macroVersion,
    modelLabel: options.model ?? 'default',
    cwdDisplay: shortenHomePath(options.cwd),
    modeLabel: options.permissionMode ?? 'default',
    tips: getLogoTips(Boolean(options.isNewUser)),
  }
}
