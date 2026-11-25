import { stat } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { env, JETBRAINS_IDES } from './env.js'
import { isEnvTruthy } from './env_utils.js'
import { execFileNoThrow } from './exec_file_no_throw.js'
import { isFeatureEnabled } from './feature_flags.js'
import { getAncestorCommandsAsync } from './generic_process_utils.js'

const getIsDocker = memoize(async (): Promise<boolean> => {
  if (process.platform !== 'linux') return false
  const { code } = await execFileNoThrow('test', ['-f', '/.dockerenv'])
  return code === 0
})

function getIsBubblewrapSandbox(): boolean {
  return (
    process.platform === 'linux' &&
    isEnvTruthy(process.env.COPILOT_CLI_BUBBLEWRAP)
  )
}

let muslRuntimeCache: boolean | null = null

if (process.platform === 'linux') {
  const muslArch = process.arch === 'x64' ? 'x86_64' : 'aarch64'
  void stat(`/lib/libc.musl-${muslArch}.so.1`).then(
    () => {
      muslRuntimeCache = true
    },
    () => {
      muslRuntimeCache = false
    },
  )
}

function isMuslEnvironment(): boolean {
  if (isFeatureEnabled('IS_LIBC_MUSL')) return true
  if (isFeatureEnabled('IS_LIBC_GLIBC')) return false
  if (process.platform !== 'linux') return false
  return muslRuntimeCache ?? false
}

let jetBrainsIdeCache: string | null | undefined

async function detectJetBrainsIdeFromParentProcessAsync(): Promise<
  string | null
> {
  if (jetBrainsIdeCache !== undefined) {
    return jetBrainsIdeCache
  }

  if (process.platform === 'darwin') {
    jetBrainsIdeCache = null
    return null
  }

  try {
    const commands = await getAncestorCommandsAsync(process.pid, 10)
    for (const command of commands) {
      const lowerCommand = command.toLowerCase()
      for (const ide of JETBRAINS_IDES) {
        if (lowerCommand.includes(ide)) {
          jetBrainsIdeCache = ide
          return ide
        }
      }
    }
  } catch {
    // Best-effort detection
  }

  jetBrainsIdeCache = null
  return null
}

export async function getTerminalWithJetBrainsDetectionAsync(): Promise<
  string | null
> {
  if (process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') {
    if (env.platform !== 'darwin') {
      const specificIde = await detectJetBrainsIdeFromParentProcessAsync()
      return specificIde || 'pycharm'
    }
  }
  return env.terminal
}

export function getTerminalWithJetBrainsDetection(): string | null {
  if (process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') {
    if (env.platform !== 'darwin') {
      if (jetBrainsIdeCache !== undefined) {
        return jetBrainsIdeCache || 'pycharm'
      }
      return 'pycharm'
    }
  }
  return env.terminal
}

export async function initJetBrainsDetection(): Promise<void> {
  if (process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') {
    await detectJetBrainsIdeFromParentProcessAsync()
  }
}

export const envDynamic = {
  ...env,
  terminal: getTerminalWithJetBrainsDetection(),
  getIsDocker,
  getIsBubblewrapSandbox,
  isMuslEnvironment,
  getTerminalWithJetBrainsDetectionAsync,
  initJetBrainsDetection,
}
