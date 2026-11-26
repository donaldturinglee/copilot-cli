import { existsSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import * as path from 'path'
import * as pathWin32 from 'path/win32'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { execSyncDeprecated } from './exec_sync_wrapper.js'
import { memoizeWithLru } from './memoize.js'
import { getPlatform } from './platform.js'

function checkPathExists(targetPath: string): boolean {
  try {
    return existsSync(targetPath)
  } catch {
    return false
  }
}

function findWindowsExecutables(executable: string): string[] {
  const results: string[] = []

  if (executable === 'git') {
    const defaultLocations = [
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    ]

    for (const location of defaultLocations) {
      if (checkPathExists(location)) {
        results.push(location)
      }
    }
  }

  try {
    const result = execSyncDeprecated(`where.exe ${executable}`, {
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim()

    const paths = result.split(/\r?\n/).filter(Boolean)
    const cwd = getCwd().toLowerCase()

    for (const candidatePath of paths) {
      const normalizedPath = path.resolve(candidatePath).toLowerCase()
      const pathDir = path.dirname(normalizedPath).toLowerCase()

      if (pathDir === cwd || normalizedPath.startsWith(cwd + path.sep)) {
        logForDebugging(
          `Skipping potentially malicious executable in current directory: ${candidatePath}`,
        )
        continue
      }

      if (!results.includes(candidatePath)) {
        results.push(candidatePath)
      }
    }
  } catch {
    // Fall through with any default locations already discovered
  }

  return results
}

/**
 * On Windows, sets SHELL to the detected git-bash executable path.
 */
export function setShellIfWindows(): void {
  if (getPlatform() === 'windows') {
    const gitBashPath = findGitBashPath()
    process.env.SHELL = gitBashPath
    logForDebugging(`Using bash path: "${gitBashPath}"`)
  }
}

/**
 * Finds the path to bash.exe bundled with Git for Windows, exiting if unavailable.
 */
export const findGitBashPath = memoize((): string => {
  if (process.env.COPILOT_CLI_GIT_BASH_PATH) {
    if (checkPathExists(process.env.COPILOT_CLI_GIT_BASH_PATH)) {
      return process.env.COPILOT_CLI_GIT_BASH_PATH
    }
    console.error(
      `Unable to find COPILOT_CLI_GIT_BASH_PATH path "${process.env.COPILOT_CLI_GIT_BASH_PATH}"`,
    )
    process.exit(1)
  }

  const gitPaths = findWindowsExecutables('git')
  for (const gitPath of gitPaths) {
    const candidates = [
      pathWin32.join(gitPath, '..', '..', 'bin', 'bash.exe'),
      pathWin32.join(gitPath, '..', '..', 'usr', 'bin', 'bash.exe'),
      pathWin32.join(gitPath, '..', '..', '..', 'bin', 'bash.exe'),
      pathWin32.join(gitPath, '..', '..', '..', 'usr', 'bin', 'bash.exe'),
    ]
    for (const bashPath of candidates) {
      if (checkPathExists(bashPath)) {
        return bashPath
      }
    }
  }

  console.error(
    'Windows requires git-bash (https://git-scm.com/downloads/win). If installed but not in PATH, set COPILOT_CLI_GIT_BASH_PATH to your bash.exe path.',
  )
  process.exit(1)
})

/** Converts a Windows path to a POSIX path using pure JS. */
export const windowsPathToPosixPath = memoizeWithLru(
  (windowsPath: string): string => {
    if (windowsPath.startsWith('\\\\')) {
      return windowsPath.replace(/\\/g, '/')
    }
    const match = windowsPath.match(/^([A-Za-z]):[/\\]/)
    if (match) {
      const driveLetter = match[1]!.toLowerCase()
      return '/' + driveLetter + windowsPath.slice(2).replace(/\\/g, '/')
    }
    return windowsPath.replace(/\\/g, '/')
  },
  inputPath => inputPath,
  500,
)

/** Converts a POSIX path to a Windows path using pure JS. */
export const posixPathToWindowsPath = memoizeWithLru(
  (posixPath: string): string => {
    if (posixPath.startsWith('//')) {
      return posixPath.replace(/\//g, '\\')
    }
    const cygdriveMatch = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/)
    if (cygdriveMatch) {
      const driveLetter = cygdriveMatch[1]!.toUpperCase()
      const rest = posixPath.slice(('/cygdrive/' + cygdriveMatch[1]).length)
      return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\')
    }
    const driveMatch = posixPath.match(/^\/([A-Za-z])(\/|$)/)
    if (driveMatch) {
      const driveLetter = driveMatch[1]!.toUpperCase()
      const rest = posixPath.slice(2)
      return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\')
    }
    return posixPath.replace(/\//g, '\\')
  },
  inputPath => inputPath,
  500,
)
