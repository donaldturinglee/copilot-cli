import { getCwd } from './cwd.js'
import { execFileNoThrowWithCwd } from './exec_file_no_throw.js'

export type ParsedRepository = {
  host: string
  owner: string
  name: string
}

const repositoryCache = new Map<string, ParsedRepository | null>()
let remoteUrlProvider: (() => Promise<string | null>) | undefined

export function registerGitRemoteUrlProvider(
  provider: () => Promise<string | null>,
): void {
  remoteUrlProvider = provider
}

async function defaultGetRemoteUrl(): Promise<string | null> {
  const result = await execFileNoThrowWithCwd(
    'git',
    ['config', '--get', 'remote.origin.url'],
    { cwd: getCwd(), timeout: 2000 },
  )
  if (result.code !== 0) {
    return null
  }
  const url = result.stdout.trim()
  return url || null
}

function looksLikeRealHostname(host: string): boolean {
  const hostWithoutPort = host.split(':')[0] ?? ''
  if (!hostWithoutPort.includes('.')) {
    return false
  }
  const tld = hostWithoutPort.split('.').pop() ?? ''
  return /^[a-zA-Z]+$/.test(tld)
}

export function clearRepositoryCaches(): void {
  repositoryCache.clear()
}

export function parseGitRemote(input: string): ParsedRepository | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (sshMatch) {
    const [, host, owner, name] = sshMatch
    if (!host || !owner || !name || !looksLikeRealHostname(host)) {
      return null
    }
    return { host, owner, name }
  }

  const urlMatch = trimmed.match(
    /^(https?|ssh|git):\/\/(?:[^@]+@)?([^/:]+(?::\d+)?)\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  )
  if (urlMatch) {
    const [, protocol, rawHost, owner, name] = urlMatch
    if (!protocol || !rawHost || !owner || !name) {
      return null
    }
    const host =
      protocol === 'http' || protocol === 'https'
        ? rawHost
        : (rawHost.split(':')[0] ?? rawHost)
    if (!looksLikeRealHostname(host)) {
      return null
    }
    return { host, owner, name }
  }

  return null
}

export function parseGitHubRepository(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  const parsed = parseGitRemote(trimmed)
  if (parsed) {
    return parsed.host === 'github.com'
      ? `${parsed.owner}/${parsed.name}`
      : null
  }

  if (
    !trimmed.includes('://') &&
    !trimmed.includes('@') &&
    trimmed.includes('/')
  ) {
    const parts = trimmed.replace(/\.git$/, '').split('/')
    if (parts.length === 2 && parts[0] && parts[1]) {
      return `${parts[0]}/${parts[1]}`
    }
  }

  return null
}

export async function detectCurrentRepositoryWithHost(): Promise<ParsedRepository | null> {
  const cwd = getCwd()
  if (repositoryCache.has(cwd)) {
    return repositoryCache.get(cwd) ?? null
  }

  const remoteUrl = remoteUrlProvider
    ? await remoteUrlProvider()
    : await defaultGetRemoteUrl()
  const parsed = remoteUrl ? parseGitRemote(remoteUrl) : null
  repositoryCache.set(cwd, parsed)
  return parsed
}

export async function detectCurrentRepository(): Promise<string | null> {
  const parsed = await detectCurrentRepositoryWithHost()
  if (!parsed || parsed.host !== 'github.com') {
    return null
  }
  return `${parsed.owner}/${parsed.name}`
}

export function getCachedRepository(): string | null {
  const parsed = repositoryCache.get(getCwd())
  if (!parsed || parsed.host !== 'github.com') {
    return null
  }
  return `${parsed.owner}/${parsed.name}`
}
