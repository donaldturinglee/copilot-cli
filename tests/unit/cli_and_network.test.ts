import { afterEach, describe, expect, test } from 'bun:test'
import {
  eagerParseCliFlag,
  extractArgsAfterDoubleDash,
} from '../../src/utilities/cli_args.js'
import {
  clearRepositoryCaches,
  parseGitHubRepository,
  parseGitRemote,
} from '../../src/utilities/detect_repository.js'
import {
  consumeEarlyInput,
  hasEarlyInput,
  seedEarlyInput,
} from '../../src/utilities/early_input.js'
import { validateBoundedIntEnvVar } from '../../src/utilities/env_validation.js'
import {
  getAuthHeaders,
  getMcpUserAgent,
  getUserAgent,
  getWebFetchUserAgent,
  registerHttpAuthProvider,
  withOauth401Retry,
} from '../../src/utilities/http.js'
import {
  getAddressFamily,
  getProxyUrl,
  shouldBypassProxy,
} from '../../src/utilities/proxy.js'
import {
  parseCommandOutputAsSettings,
  parseRegQueryStdout,
} from '../../src/utilities/settings/mdm/settings.js'
import { getSystemDirectories } from '../../src/utilities/system_directories.js'
import {
  initializeWarningHandler,
  resetWarningHandler,
} from '../../src/utilities/warning_handler.js'

afterEach(() => {
  registerHttpAuthProvider(undefined)
  clearRepositoryCaches()
  resetWarningHandler()
})

describe('Step 1.4 CLI args, networking, repository, and MDM utilities', () => {
  test('eagerParseCliFlag and extractArgsAfterDoubleDash parse CLI flags accurately', () => {
    const argv = [
      'bun',
      'cli.tsx',
      '--settings=/tmp/a.json',
      '--setting-sources',
      'user,local',
    ]
    expect(eagerParseCliFlag('--settings', argv)).toBe('/tmp/a.json')
    expect(eagerParseCliFlag('--setting-sources', argv)).toBe('user,local')
    expect(eagerParseCliFlag('--missing', argv)).toBeUndefined()

    expect(extractArgsAfterDoubleDash('--', ['git', 'status'])).toEqual({
      command: 'git',
      args: ['status'],
    })
    expect(extractArgsAfterDoubleDash('echo', ['hi'])).toEqual({
      command: 'echo',
      args: ['hi'],
    })
  })

  test('proxy URL precedence, NO_PROXY matching, and address family mapping', () => {
    expect(
      getProxyUrl({
        http_proxy: 'http://h1:8080',
        HTTPS_PROXY: 'http://s1:8443',
      }),
    ).toBe('http://s1:8443')

    expect(shouldBypassProxy('https://api.example.com', '*')).toBe(true)
    expect(shouldBypassProxy('https://sub.example.com', '.example.com')).toBe(
      true,
    )
    expect(shouldBypassProxy('https://example.com', '.example.com')).toBe(true)
    expect(shouldBypassProxy('https://localhost:443', 'localhost:443')).toBe(
      true,
    )
    expect(shouldBypassProxy('https://api.anthropic.com', 'localhost')).toBe(
      false,
    )

    expect(getAddressFamily({})).toBe(4)
    expect(getAddressFamily({ family: 'IPv6' })).toBe(6)
    expect(getAddressFamily({ family: 0 })).toBe(0)
  })

  test('HTTP user agents, auth headers, and OAuth 401 retry work with provider hooks', async () => {
    expect(getUserAgent()).toContain('claude-cli/')
    expect(getMcpUserAgent()).toContain('claude-code/')
    expect(getWebFetchUserAgent()).toContain('Claude-User (claude-code/')

    let token = 'expired-token'
    let refreshes = 0
    registerHttpAuthProvider({
      isClaudeAiSubscriber: () => true,
      getOauthAccessToken: () => token,
      getApiKey: () => undefined,
      handleOauth401Error: async () => {
        refreshes++
        token = 'fresh-token'
      },
    })

    expect(getAuthHeaders().headers.Authorization).toBe('Bearer expired-token')

    let attempts = 0
    const result = await withOauth401Retry(async () => {
      attempts++
      if (attempts === 1) {
        throw { isAxiosError: true, response: { status: 401 } }
      }
      return token
    })
    expect(result).toBe('fresh-token')
    expect(refreshes).toBe(1)
    expect(attempts).toBe(2)
  })

  test('git remote parser extracts host/owner/name and rejects SSH aliases', () => {
    expect(parseGitRemote('git@github.com:org/repo.git')).toEqual({
      host: 'github.com',
      owner: 'org',
      name: 'repo',
    })
    expect(parseGitRemote('https://github.com/org/repo.git')).toEqual({
      host: 'github.com',
      owner: 'org',
      name: 'repo',
    })
    expect(parseGitRemote('git@github-work:org/repo.git')).toBeNull()

    expect(parseGitHubRepository('https://github.com/octo/cli.git')).toBe(
      'octo/cli',
    )
    expect(parseGitHubRepository('https://gitlab.com/octo/cli.git')).toBeNull()
    expect(parseGitHubRepository('octo/cli')).toBe('octo/cli')
  })

  test('system directories, early input buffer, env validation, and MDM parsers', () => {
    const linuxDirs = getSystemDirectories({
      platform: 'linux',
      homedir: '/home/dev',
      env: { XDG_DOWNLOAD_DIR: '/data/downloads' },
    })
    expect(linuxDirs.home).toBe('/home/dev')
    expect(linuxDirs.downloads).toBe('/data/downloads')

    seedEarlyInput('  hello world  ')
    expect(hasEarlyInput()).toBe(true)
    expect(consumeEarlyInput()).toBe('hello world')
    expect(hasEarlyInput()).toBe(false)

    expect(validateBoundedIntEnvVar('LIMIT', '200', 50, 100)).toEqual({
      effective: 100,
      status: 'capped',
      message: 'Capped from 200 to 100',
    })
    expect(validateBoundedIntEnvVar('LIMIT', 'bad', 50, 100).status).toBe(
      'invalid',
    )

    const regOut =
      '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\ClaudeCode\r\n    Settings    REG_SZ    {"model":"opus"}\r\n'
    const extracted = parseRegQueryStdout(regOut)
    expect(extracted).toBe('{"model":"opus"}')
    const parsedMdm = parseCommandOutputAsSettings(extracted!, 'HKLM')
    expect(parsedMdm.settings.model).toBe('opus')
    expect(parsedMdm.errors).toEqual([])

    initializeWarningHandler()
    initializeWarningHandler()
    resetWarningHandler()
  })
})
