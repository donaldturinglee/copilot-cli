/**
 * Multi-source Marketplace manager (`directory`, `file`, `url`, `github`, `git`,
 * `settings`) with anti-spoofing, enterprise `strictKnownMarketplaces` /
 * `blockedMarketplaces` enforcement, and versioned plugin snapshot caching.
 */

import axios from 'axios'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { dirname, join, resolve } from 'path'
import { execFileNoThrowWithCwd } from '../exec_file_no_throw.js'
import { getInitialSettings } from '../settings/settings.js'
import {
  findMarketplaceManifestPath,
  findPluginManifestPath,
  getKnownMarketplacesFilePath,
  getMarketplacesDir,
  getVersionedPluginCachePath,
  resolvePathWithinPlugin,
} from './plugin_directories.js'
import { validateOfficialNameSource } from './official_marketplace.js'
import { canUseMarketplaceSource } from './plugin_policy.js'
import {
  KnownMarketplacesFileSchema,
  PluginManifestSchema,
  PluginMarketplaceSchema,
  type KnownMarketplaceRecord,
  type MarketplaceSource,
  type PluginMarketplaceEntry,
  type PluginMarketplaceManifest,
} from './schemas.js'

let marketplaceManifestCache = new Map<string, PluginMarketplaceManifest>()

/**
 * Clears in-memory marketplace manifest caches.
 */
export function clearMarketplaceCache(): void {
  marketplaceManifestCache = new Map()
}

/**
 * Reads `known_marketplaces.json` from `~/.copilot/plugins/`.
 */
export function readKnownMarketplaces(): Record<string, KnownMarketplaceRecord> {
  const filePath = getKnownMarketplacesFilePath()
  if (!existsSync(filePath)) {
    return {}
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    const parsed = KnownMarketplacesFileSchema().safeParse(raw)
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

function writeKnownMarketplaces(
  records: Record<string, KnownMarketplaceRecord>,
): void {
  const filePath = getKnownMarketplacesFilePath()
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmpPath, `${JSON.stringify(records, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  renameSync(tmpPath, filePath)
}

async function runNonInteractiveGit(
  args: string[],
  cwd: string,
): Promise<void> {
  const res = await execFileNoThrowWithCwd('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    },
    timeout: 120_000,
  })
  if (res.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${res.stderr || res.stdout}`)
  }
}

async function fetchMarketplaceToLocation(
  source: MarketplaceSource,
  targetHintDir?: string,
): Promise<{ installLocation: string; manifest: PluginMarketplaceManifest }> {
  const policyCheck = canUseMarketplaceSource(source)
  if (!policyCheck.allowed) {
    throw new Error(
      policyCheck.blockedByBlocklist
        ? 'Marketplace source is blocked by enterprise policy'
        : 'Marketplace source is not in strictKnownMarketplaces allowlist',
    )
  }

  if (source.source === 'npm') {
    throw new Error('npm marketplace sources are not yet implemented')
  }

  if (source.source === 'settings') {
    const manifest = PluginMarketplaceSchema().parse({
      name: source.name,
      owner: source.owner,
      plugins: source.plugins,
    })
    return { installLocation: `settings:${source.name}`, manifest }
  }

  if (source.source === 'file') {
    const absFile = resolve(source.path)
    if (!existsSync(absFile)) {
      throw new Error(`Marketplace file not found: ${absFile}`)
    }
    const raw: unknown = JSON.parse(readFileSync(absFile, 'utf8'))
    const manifest = PluginMarketplaceSchema().parse(raw)
    const officialCheck = validateOfficialNameSource(manifest.name, source)
    if (!officialCheck.valid) {
      throw new Error(officialCheck.reason)
    }
    return { installLocation: dirname(absFile), manifest }
  }

  if (source.source === 'directory') {
    const absDir = resolve(source.path)
    const manifestPath = findMarketplaceManifestPath(absDir)
    if (!manifestPath) {
      throw new Error(
        `No marketplace.json found in ${absDir} (expected .copilot-plugin/marketplace.json or .claude-plugin/marketplace.json)`,
      )
    }
    const raw: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const manifest = PluginMarketplaceSchema().parse(raw)
    const officialCheck = validateOfficialNameSource(manifest.name, source)
    if (!officialCheck.valid) {
      throw new Error(officialCheck.reason)
    }
    return { installLocation: absDir, manifest }
  }

  if (source.source === 'url') {
    const response = await axios.get<unknown>(source.url, {
      headers: source.headers,
      timeout: 30_000,
    })
    const manifest = PluginMarketplaceSchema().parse(response.data)
    const officialCheck = validateOfficialNameSource(manifest.name, source)
    if (!officialCheck.valid) {
      throw new Error(officialCheck.reason)
    }
    const destDir = targetHintDir ?? join(getMarketplacesDir(), manifest.name)
    mkdirSync(join(destDir, '.copilot-plugin'), {
      recursive: true,
      mode: 0o700,
    })
    writeFileSync(
      join(destDir, '.copilot-plugin', 'marketplace.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    )
    return { installLocation: destDir, manifest }
  }

  if (source.source === 'github' || source.source === 'git') {
    const gitUrl =
      source.source === 'github'
        ? `https://github.com/${source.repo}.git`
        : source.url
    const tempCloneDir =
      targetHintDir ??
      join(getMarketplacesDir(), `.tmp-mp-${process.pid}-${Date.now()}`)
    mkdirSync(dirname(tempCloneDir), { recursive: true, mode: 0o700 })

    if (existsSync(join(tempCloneDir, '.git'))) {
      await runNonInteractiveGit(['pull', '--ff-only'], tempCloneDir)
    } else {
      const cloneArgs = ['clone', '--depth', '1']
      if (source.ref) {
        cloneArgs.push('--branch', source.ref)
      }
      if (source.sparsePaths?.length) {
        cloneArgs.push('--filter=blob:none', '--no-checkout')
      }
      cloneArgs.push(gitUrl, tempCloneDir)
      await runNonInteractiveGit(cloneArgs, dirname(tempCloneDir))
      if (source.sparsePaths?.length) {
        await runNonInteractiveGit(
          [
            'sparse-checkout',
            'set',
            '--cone',
            '.copilot-plugin',
            '.claude-plugin',
            ...source.sparsePaths,
          ],
          tempCloneDir,
        )
        await runNonInteractiveGit(['checkout'], tempCloneDir)
      }
    }

    const searchRoot = source.path
      ? resolve(tempCloneDir, source.path)
      : tempCloneDir
    const manifestPath = findMarketplaceManifestPath(searchRoot)
    if (!manifestPath) {
      rmSync(tempCloneDir, { recursive: true, force: true })
      throw new Error(`Cloned repository does not contain marketplace.json`)
    }
    const raw: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const manifest = PluginMarketplaceSchema().parse(raw)
    const officialCheck = validateOfficialNameSource(manifest.name, source)
    if (!officialCheck.valid) {
      if (!targetHintDir) {
        rmSync(tempCloneDir, { recursive: true, force: true })
      }
      throw new Error(officialCheck.reason)
    }

    const finalDir = join(getMarketplacesDir(), manifest.name)
    if (tempCloneDir !== finalDir) {
      rmSync(finalDir, { recursive: true, force: true })
      renameSync(tempCloneDir, finalDir)
    }
    return {
      installLocation: source.path ? resolve(finalDir, source.path) : finalDir,
      manifest,
    }
  }

  throw new Error(`Unsupported marketplace source`)
}

/**
 * Registers or updates a marketplace from `source` into `known_marketplaces.json`.
 */
export async function addMarketplace(
  source: MarketplaceSource,
  options?: { autoUpdate?: boolean },
): Promise<{ name: string; manifest: PluginMarketplaceManifest; record: KnownMarketplaceRecord }> {
  const { installLocation, manifest } = await fetchMarketplaceToLocation(source)
  const known = readKnownMarketplaces()
  const record: KnownMarketplaceRecord = {
    source,
    installLocation,
    lastUpdated: new Date().toISOString(),
    ...(options?.autoUpdate !== undefined
      ? { autoUpdate: options.autoUpdate }
      : {}),
  }
  known[manifest.name] = record
  writeKnownMarketplaces(known)
  marketplaceManifestCache.set(manifest.name, manifest)
  return { name: manifest.name, manifest, record }
}

/**
 * Removes a registered marketplace by name.
 */
export function removeMarketplace(name: string): boolean {
  const known = readKnownMarketplaces()
  const existing = known[name]
  if (!existing) {
    return false
  }
  // Only delete managed clone dir inside `~/.copilot/plugins/marketplaces/` —
  // NEVER delete user-owned `directory` or `file` paths!
  const managedRoot = resolve(getMarketplacesDir())
  const loc = resolve(existing.installLocation)
  if (loc.startsWith(managedRoot) && loc !== managedRoot && existsSync(loc)) {
    rmSync(loc, { recursive: true, force: true })
  }
  delete known[name]
  writeKnownMarketplaces(known)
  marketplaceManifestCache.delete(name)
  return true
}

/**
 * Updates one or all registered marketplaces from their upstream sources.
 */
export async function updateMarketplaces(
  targetName?: string,
): Promise<string[]> {
  const known = readKnownMarketplaces()
  const names = targetName ? [targetName] : Object.keys(known)
  const updated: string[] = []

  for (const name of names) {
    const rec = known[name]
    if (!rec) {
      if (targetName) {
        throw new Error(`Marketplace "${targetName}" is not registered`)
      }
      continue
    }
    const refreshed = await fetchMarketplaceToLocation(
      rec.source,
      rec.source.source === 'github' || rec.source.source === 'git'
        ? rec.installLocation
        : undefined,
    )
    known[name] = {
      ...rec,
      installLocation: refreshed.installLocation,
      lastUpdated: new Date().toISOString(),
    }
    marketplaceManifestCache.set(name, refreshed.manifest)
    updated.push(name)
  }

  writeKnownMarketplaces(known)
  return updated
}

/**
 * Loads the parsed `PluginMarketplaceManifest` for `marketplaceName` from disk
 * or inline `settings.extraKnownMarketplaces`.
 */
export function loadMarketplaceManifest(
  marketplaceName: string,
): PluginMarketplaceManifest | null {
  const cached = marketplaceManifestCache.get(marketplaceName)
  if (cached) {
    return cached
  }

  const known = readKnownMarketplaces()
  const rec = known[marketplaceName]
  if (rec) {
    const policyCheck = canUseMarketplaceSource(rec.source)
    if (!policyCheck.allowed) {
      return null
    }
    if (rec.source.source === 'settings') {
      const parsed = PluginMarketplaceSchema().safeParse({
        name: rec.source.name,
        owner: rec.source.owner,
        plugins: rec.source.plugins,
      })
      if (parsed.success) {
        marketplaceManifestCache.set(marketplaceName, parsed.data)
        return parsed.data
      }
      return null
    }

    const manifestPath = findMarketplaceManifestPath(rec.installLocation)
    if (!manifestPath) {
      return null
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const parsed = PluginMarketplaceSchema().safeParse(raw)
      if (parsed.success) {
        marketplaceManifestCache.set(marketplaceName, parsed.data)
        return parsed.data
      }
    } catch {
      return null
    }
  }

  // Check inline `settings` marketplaces in `extraKnownMarketplaces`
  const extra = getInitialSettings().extraKnownMarketplaces
  const extraEntry = extra?.[marketplaceName]
  if (extraEntry?.source?.source === 'settings') {
    const parsed = PluginMarketplaceSchema().safeParse(extraEntry.source)
    if (parsed.success) {
      marketplaceManifestCache.set(marketplaceName, parsed.data)
      return parsed.data
    }
  }

  return null
}

/**
 * Lists all loaded marketplaces and their entries.
 */
export function listAllMarketplaces(): Array<{
  name: string
  record: KnownMarketplaceRecord
  manifest: PluginMarketplaceManifest | null
}> {
  const known = readKnownMarketplaces()
  return Object.entries(known).map(([name, record]) => ({
    name,
    record,
    manifest: loadMarketplaceManifest(name),
  }))
}

/**
 * Materializes a marketplace plugin entry into the versioned plugin cache
 * (`~/.copilot/plugins/cache/<marketplace>/<plugin>/<version>`) and returns its
 * cached `installPath` and resolved version.
 */
export async function cacheMarketplacePlugin(
  marketplaceName: string,
  entry: PluginMarketplaceEntry,
): Promise<{ installPath: string; version: string }> {
  const known = readKnownMarketplaces()
  const mpRecord = known[marketplaceName]
  const mpManifest = loadMarketplaceManifest(marketplaceName)
  if (!mpManifest) {
    throw new Error(`Marketplace "${marketplaceName}" could not be loaded`)
  }

  if (typeof entry.source === 'object' && entry.source.source === 'pip') {
    throw new Error('pip plugin sources are not yet supported')
  }

  let sourceDir: string
  let cleanupTempDir: string | null = null

  if (typeof entry.source === 'string') {
    if (!mpRecord) {
      throw new Error(
        `Marketplace "${marketplaceName}" has no local install location for relative plugin "${entry.name}"`,
      )
    }
    const baseRoot = resolve(
      mpRecord.installLocation,
      mpManifest.metadata?.pluginRoot ?? '.',
    )
    const resolvedLocal = resolvePathWithinPlugin(baseRoot, entry.source)
    if (!resolvedLocal || !existsSync(resolvedLocal)) {
      throw new Error(
        `Plugin "${entry.name}" source directory "${entry.source}" does not exist in marketplace "${marketplaceName}"`,
      )
    }
    sourceDir = resolvedLocal
  } else if (
    entry.source.source === 'github' ||
    entry.source.source === 'url' ||
    entry.source.source === 'git-subdir'
  ) {
    const gitUrl =
      entry.source.source === 'github'
        ? `https://github.com/${entry.source.repo}.git`
        : entry.source.url
    const tmpDir = join(
      getMarketplacesDir(),
      `.tmp-plug-${entry.name}-${Date.now()}`,
    )
    mkdirSync(dirname(tmpDir), { recursive: true, mode: 0o700 })
    const cloneArgs = ['clone', '--depth', '1']
    if (entry.source.ref) {
      cloneArgs.push('--branch', entry.source.ref)
    }
    cloneArgs.push(gitUrl, tmpDir)
    await runNonInteractiveGit(cloneArgs, dirname(tmpDir))
    cleanupTempDir = tmpDir
    sourceDir =
      entry.source.source === 'git-subdir'
        ? resolve(tmpDir, entry.source.path)
        : tmpDir
  } else {
    throw new Error(`Unsupported plugin source type: ${entry.source.source}`)
  }

  try {
    let version = entry.version ?? '0.0.0'
    const diskManifestPath = findPluginManifestPath(sourceDir)
    if (diskManifestPath) {
      try {
        const parsedDisk = PluginManifestSchema().safeParse(
          JSON.parse(readFileSync(diskManifestPath, 'utf8')),
        )
        if (parsedDisk.success && parsedDisk.data.version) {
          version = parsedDisk.data.version
        }
      } catch {
        // Keep entry version
      }
    }

    const cacheDest = getVersionedPluginCachePath(
      marketplaceName,
      entry.name,
      version,
    )
    rmSync(cacheDest, { recursive: true, force: true })
    mkdirSync(dirname(cacheDest), { recursive: true, mode: 0o700 })
    cpSync(sourceDir, cacheDest, { recursive: true })

    // If `strict === false` and no disk manifest exists, synthesize `.copilot-plugin/plugin.json`
    if (!findPluginManifestPath(cacheDest) && entry.strict === false) {
      const synthDir = join(cacheDest, '.copilot-plugin')
      mkdirSync(synthDir, { recursive: true, mode: 0o700 })
      const { source: _src, strict: _strict, category: _cat, tags: _tags, ...manifestFields } =
        entry
      writeFileSync(
        join(synthDir, 'plugin.json'),
        JSON.stringify({ ...manifestFields, name: entry.name, version }, null, 2),
        'utf8',
      )
    }

    return { installPath: cacheDest, version }
  } finally {
    if (cleanupTempDir) {
      rmSync(cleanupTempDir, { recursive: true, force: true })
    }
  }
}
