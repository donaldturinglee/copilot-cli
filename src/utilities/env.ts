import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { join } from 'path'
import { isRunningWithBun } from './bundled_mode.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './env_utils.js'
import { findExecutable } from './find_executable.js'
import { getFsImplementation } from './fs_operations.js'
import { which } from './which.js'

type HostPlatform = 'win32' | 'darwin' | 'linux'

function fileSuffixForOauthConfig(): string {
  if (process.env.COPILOT_CLI_CUSTOM_OAUTH_URL) {
    return '-custom-oauth'
  }
  return ''
}

export const getGlobalClaudeFile = memoize(
  (): string => {
    const legacyConfig = join(getClaudeConfigHomeDir(), '.config.json')
    if (getFsImplementation().existsSync(legacyConfig)) {
      return legacyConfig
    }
    const filename = `.copilot${fileSuffixForOauthConfig()}.json`
    return join(process.env.CLAUDE_CONFIG_DIR || homedir(), filename)
  },
  () =>
    `${process.env.CLAUDE_CONFIG_DIR ?? ''}:${process.env.COPILOT_CLI_CUSTOM_OAUTH_URL ?? ''}`,
)

const hasInternetAccess = memoize(async (): Promise<boolean> => {
  try {
    const { default: axiosClient } = await import('axios')
    await axiosClient.head('http://1.1.1.1', {
      signal: AbortSignal.timeout(1000),
    })
    return true
  } catch {
    return false
  }
})

async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    return Boolean(await which(command))
  } catch {
    return false
  }
}

const detectPackageManagers = memoize(async (): Promise<string[]> => {
  const packageManagers: string[] = []
  if (await isCommandAvailable('npm')) packageManagers.push('npm')
  if (await isCommandAvailable('yarn')) packageManagers.push('yarn')
  if (await isCommandAvailable('pnpm')) packageManagers.push('pnpm')
  return packageManagers
})

const detectRuntimes = memoize(async (): Promise<string[]> => {
  const runtimes: string[] = []
  if (await isCommandAvailable('bun')) runtimes.push('bun')
  if (await isCommandAvailable('deno')) runtimes.push('deno')
  if (await isCommandAvailable('node')) runtimes.push('node')
  return runtimes
})

const isWslEnvironment = memoize((): boolean => {
  try {
    return getFsImplementation().existsSync(
      '/proc/sys/fs/binfmt_misc/WSLInterop',
    )
  } catch {
    return false
  }
})

const isNpmFromWindowsPath = memoize((): boolean => {
  try {
    if (!isWslEnvironment()) {
      return false
    }
    const { cmd } = findExecutable('npm', [])
    return cmd.startsWith('/mnt/c/')
  } catch {
    return false
  }
})

function isConductor(): boolean {
  return process.env.__CFBundleIdentifier === 'com.conductor.app'
}

export const JETBRAINS_IDES = [
  'pycharm',
  'intellij',
  'webstorm',
  'phpstorm',
  'rubymine',
  'clion',
  'goland',
  'rider',
  'datagrip',
  'appcode',
  'dataspell',
  'aqua',
  'gateway',
  'fleet',
  'jetbrains',
  'androidstudio',
]

function isSshSession(): boolean {
  return Boolean(
    process.env.SSH_CONNECTION ||
      process.env.SSH_CLIENT ||
      process.env.SSH_TTY,
  )
}

function detectTerminal(): string | null {
  if (process.env.CURSOR_TRACE_ID) return 'cursor'
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes('cursor')) {
    return 'cursor'
  }
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes('windsurf')) {
    return 'windsurf'
  }
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes('antigravity')) {
    return 'antigravity'
  }
  const bundleId = process.env.__CFBundleIdentifier?.toLowerCase()
  if (bundleId?.includes('vscodium')) return 'codium'
  if (bundleId?.includes('windsurf')) return 'windsurf'
  if (bundleId?.includes('com.google.android.studio')) return 'androidstudio'
  if (bundleId) {
    for (const ide of JETBRAINS_IDES) {
      if (bundleId.includes(ide)) return ide
    }
  }
  if (process.env.VisualStudioVersion) return 'visualstudio'
  if (process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') return 'pycharm'
  if (process.env.TERM === 'xterm-ghostty') return 'ghostty'
  if (process.env.TERM?.includes('kitty')) return 'kitty'
  if (process.env.TERM_PROGRAM) return process.env.TERM_PROGRAM
  if (process.env.TMUX) return 'tmux'
  if (process.env.STY) return 'screen'
  if (process.env.KONSOLE_VERSION) return 'konsole'
  if (process.env.GNOME_TERMINAL_SERVICE) return 'gnome-terminal'
  if (process.env.XTERM_VERSION) return 'xterm'
  if (process.env.VTE_VERSION) return 'vte-based'
  if (process.env.TERMINATOR_UUID) return 'terminator'
  if (process.env.KITTY_WINDOW_ID) return 'kitty'
  if (process.env.ALACRITTY_LOG) return 'alacritty'
  if (process.env.TILIX_ID) return 'tilix'
  if (process.env.WT_SESSION) return 'windows-terminal'
  if (process.env.SESSIONNAME && process.env.TERM === 'cygwin') return 'cygwin'
  if (process.env.MSYSTEM) return process.env.MSYSTEM.toLowerCase()
  if (
    process.env.ConEmuANSI ||
    process.env.ConEmuPID ||
    process.env.ConEmuTask
  ) {
    return 'conemu'
  }
  if (process.env.WSL_DISTRO_NAME) return `wsl-${process.env.WSL_DISTRO_NAME}`
  if (isSshSession()) return 'ssh-session'
  if (process.env.TERM) {
    const term = process.env.TERM
    if (term.includes('alacritty')) return 'alacritty'
    if (term.includes('rxvt')) return 'rxvt'
    if (term.includes('termite')) return 'termite'
    return term
  }
  if (!process.stdout.isTTY) return 'non-interactive'
  return null
}

export const detectDeploymentEnvironment = memoize((): string => {
  if (isEnvTruthy(process.env.CODESPACES)) return 'codespaces'
  if (process.env.GITPOD_WORKSPACE_ID) return 'gitpod'
  if (process.env.REPL_ID || process.env.REPL_SLUG) return 'replit'
  if (process.env.PROJECT_DOMAIN) return 'glitch'
  if (isEnvTruthy(process.env.VERCEL)) return 'vercel'
  if (
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.RAILWAY_SERVICE_NAME
  ) {
    return 'railway'
  }
  if (isEnvTruthy(process.env.RENDER)) return 'render'
  if (isEnvTruthy(process.env.NETLIFY)) return 'netlify'
  if (process.env.DYNO) return 'heroku'
  if (process.env.FLY_APP_NAME || process.env.FLY_MACHINE_ID) return 'fly.io'
  if (isEnvTruthy(process.env.CF_PAGES)) return 'cloudflare-pages'
  if (process.env.DENO_DEPLOYMENT_ID) return 'deno-deploy'
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return 'aws-lambda'
  if (process.env.AWS_EXECUTION_ENV === 'AWS_ECS_FARGATE') return 'aws-fargate'
  if (process.env.AWS_EXECUTION_ENV === 'AWS_ECS_EC2') return 'aws-ecs'
  try {
    const uuid = getFsImplementation()
      .readFileSync('/sys/hypervisor/uuid', { encoding: 'utf8' })
      .trim()
      .toLowerCase()
    if (uuid.startsWith('ec2')) return 'aws-ec2'
  } catch {
    // Non-EC2
  }
  if (process.env.K_SERVICE) return 'gcp-cloud-run'
  if (process.env.GOOGLE_CLOUD_PROJECT) return 'gcp'
  if (process.env.WEBSITE_SITE_NAME || process.env.WEBSITE_SKU) {
    return 'azure-app-service'
  }
  if (process.env.AZURE_FUNCTIONS_ENVIRONMENT) return 'azure-functions'
  if (process.env.APP_URL?.includes('ondigitalocean.app')) {
    return 'digitalocean-app-platform'
  }
  if (process.env.SPACE_CREATOR_USER_ID) return 'huggingface-spaces'
  if (isEnvTruthy(process.env.GITHUB_ACTIONS)) return 'github-actions'
  if (isEnvTruthy(process.env.GITLAB_CI)) return 'gitlab-ci'
  if (process.env.CIRCLECI) return 'circleci'
  if (process.env.BUILDKITE) return 'buildkite'
  if (isEnvTruthy(process.env.CI)) return 'ci'
  if (process.env.KUBERNETES_SERVICE_HOST) return 'kubernetes'
  try {
    if (getFsImplementation().existsSync('/.dockerenv')) return 'docker'
  } catch {
    // Ignore Docker check failure
  }
  if (env.platform === 'darwin') return 'unknown-darwin'
  if (env.platform === 'linux') return 'unknown-linux'
  if (env.platform === 'win32') return 'unknown-win32'
  return 'unknown'
})

export const env = {
  hasInternetAccess,
  isCi: isEnvTruthy(process.env.CI),
  platform: (['win32', 'darwin'].includes(process.platform)
    ? process.platform
    : 'linux') as HostPlatform,
  arch: process.arch,
  nodeVersion: process.version,
  terminal: detectTerminal(),
  isSsh: isSshSession,
  getPackageManagers: detectPackageManagers,
  getRuntimes: detectRuntimes,
  isRunningWithBun: memoize(isRunningWithBun),
  isWslEnvironment,
  isNpmFromWindowsPath,
  isConductor,
  detectDeploymentEnvironment,
}

export function getHostPlatformForAnalytics(): HostPlatform {
  const override = process.env.COPILOT_CLI_HOST_PLATFORM
  if (override === 'win32' || override === 'darwin' || override === 'linux') {
    return override
  }
  return env.platform
}
