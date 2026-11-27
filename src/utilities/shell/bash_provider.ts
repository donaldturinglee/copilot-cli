/**
 * POSIX / Git-Bash shell provider implementing session snapshot sourcing,
 * `CLAUDE_ENV_FILE` loading, `extglob` disabling, `eval` quoting, and trailing
 * `pwd` capture to a temporary CWD persistence file.
 */

import { formatShellPrefixCommand } from '../bash/shell_prefix.js'
import { quoteShellCommand } from '../bash/shell_quoting.js'
import { isEnvTruthy } from '../env_utils.js'
import { getPlatform } from '../platform.js'
import type { ShellCommandBuildOptions, ShellProvider } from './shell_provider.js'

function toBashPath(filePath: string): string {
  return getPlatform() === 'windows' ? filePath.replace(/\\/g, '/') : filePath
}

export class BashProvider implements ShellProvider {
  readonly kind = 'bash' as const
  readonly shellPath: string

  constructor(shellPath: string) {
    this.shellPath = shellPath
  }

  buildCommand(options: ShellCommandBuildOptions): string {
    const parts: string[] = []

    if (options.snapshotPath) {
      parts.push(
        `source ${quoteShellCommand(toBashPath(options.snapshotPath))} 2>/dev/null || true`,
      )
    }

    if (options.envFiles && options.envFiles.length > 0) {
      for (const envFile of options.envFiles) {
        parts.push(
          `source ${quoteShellCommand(toBashPath(envFile))} 2>/dev/null || true`,
        )
      }
    }

    // Disable bash extended globbing for predictable expansion behavior
    parts.push('shopt -u extglob 2>/dev/null || true')

    const prefixed = formatShellPrefixCommand(
      options.shellPrefix,
      options.command,
    )
    const quotedCmd = quoteShellCommand(prefixed)
    const cwdFileBash = quoteShellCommand(toBashPath(options.cwdFile))

    // Capture command exit code before persisting working directory.
    // On Windows Git Bash, `pwd -W` outputs native Windows path (C:/...) cleanly.
    const pwdCmd =
      getPlatform() === 'windows'
        ? `(pwd -W 2>/dev/null || pwd -P) >| ${cwdFileBash}`
        : `pwd -P >| ${cwdFileBash}`

    parts.push(`eval ${quotedCmd}`)
    parts.push('__copilot_exit=$?')
    parts.push(pwdCmd)
    parts.push('exit $__copilot_exit')

    return parts.join('\n')
  }

  getSpawnArgs(
    script: string,
    options?: { hasSnapshot?: boolean },
  ): string[] {
    const skipLogin =
      Boolean(options?.hasSnapshot) ||
      getPlatform() === 'windows' ||
      isEnvTruthy(process.env.COPILOT_CLI_SHELL_NO_LOGIN) ||
      process.env.NODE_ENV === 'test'

    if (skipLogin) {
      return ['-c', script]
    }
    return ['-l', '-c', script]
  }
}
