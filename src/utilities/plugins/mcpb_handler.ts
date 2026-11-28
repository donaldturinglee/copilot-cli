/**
 * `.mcpb` and `.dxt` Desktop Extension bundle downloader, content-addressed
 * extractor (`<pluginPath>/.mcpb-cache/`), manifest validator, and MCP server
 * config resolver.
 */

import axios from 'axios'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import type { McpServerConfig } from '../../services/mcp/types.js'
import { getSystemDirectories, loadMcpbModule } from '../dxt/helpers.js'
import { extractZipToDirectory, unzipBuffer } from '../dxt/zip.js'
import { resolvePathWithinPlugin } from './plugin_directories.js'
import {
  loadMcpServerUserConfig,
  type PluginOptionValues,
} from './plugin_options_storage.js'

export interface McpbCacheMetadata {
  source: string
  contentHash: string
  extractedPath: string
  cachedAt: string
  lastChecked: string
}

export type McpbLoadResult =
  | {
      status: 'loaded'
      serverName: string
      config: McpServerConfig
      userConfig: PluginOptionValues
    }
  | {
      status: 'needs-config'
      serverName: string
      extractedPath: string
      missingFields: string[]
      validationErrors: string[]
    }

/**
 * Returns true if `source` points to a `.mcpb` or `.dxt` package path or URL.
 */
export function isMcpbSource(source: string): boolean {
  const lower = source.trim().toLowerCase()
  return lower.endsWith('.mcpb') || lower.endsWith('.dxt')
}

async function fetchMcpbBytes(
  source: string,
  pluginPath: string,
): Promise<{ bytes: Uint8Array; localMtimeMs?: number }> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const response = await axios.get<ArrayBuffer>(source, {
      responseType: 'arraybuffer',
      timeout: 120_000,
      maxRedirects: 5,
    })
    return { bytes: new Uint8Array(response.data) }
  }

  const localPath = resolvePathWithinPlugin(pluginPath, source)
  if (!localPath) {
    throw new Error(
      `MCPB path "${source}" escapes plugin directory "${pluginPath}"`,
    )
  }
  const [buf, fileStats] = await Promise.all([
    readFile(localPath),
    stat(localPath),
  ])
  return {
    bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    localMtimeMs: Math.floor(fileStats.mtimeMs),
  }
}

async function extractMcpbWithCache(
  source: string,
  pluginPath: string,
): Promise<string> {
  const cacheRoot = join(pluginPath, '.mcpb-cache')
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  const sourceKey = createHash('md5').update(source).digest('hex').slice(0, 8)
  const metaPath = join(cacheRoot, `${sourceKey}.metadata.json`)

  if (
    existsSync(metaPath) &&
    !source.startsWith('http://') &&
    !source.startsWith('https://')
  ) {
    const localPath = resolvePathWithinPlugin(pluginPath, source)
    if (localPath && existsSync(localPath)) {
      try {
        const [metaRaw, st] = await Promise.all([
          readFile(metaPath, 'utf8'),
          stat(localPath),
        ])
        const meta = JSON.parse(metaRaw) as McpbCacheMetadata
        if (
          existsSync(meta.extractedPath) &&
          Math.floor(st.mtimeMs) <= Date.parse(meta.cachedAt)
        ) {
          return meta.extractedPath
        }
      } catch {
        // Re-extract on corrupt metadata
      }
    }
  }

  const { bytes } = await fetchMcpbBytes(source, pluginPath)
  const contentHash = createHash('sha256')
    .update(bytes)
    .digest('hex')
    .slice(0, 16)
  const finalDir = join(cacheRoot, contentHash)

  if (!existsSync(finalDir)) {
    const tempDir = join(cacheRoot, `.tmp-${contentHash}-${Date.now()}`)
    try {
      const { files, modes } = await unzipBuffer(bytes)
      await extractZipToDirectory(files, tempDir, modes)
      await rename(tempDir, finalDir)
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  const nowIso = new Date().toISOString()
  const metadata: McpbCacheMetadata = {
    source,
    contentHash,
    extractedPath: finalDir,
    cachedAt: nowIso,
    lastChecked: nowIso,
  }
  await writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf8')
  return finalDir
}

/**
 * Loads, extracts, validates, and resolves an `.mcpb` or `.dxt` bundle into an
 * `McpServerConfig`.
 */
export async function loadMcpbServer(params: {
  source: string
  pluginPath: string
  pluginId: string
  userConfigOverrides?: PluginOptionValues
  forceConfigDialog?: boolean
}): Promise<McpbLoadResult> {
  const extractedPath = await extractMcpbWithCache(
    params.source,
    params.pluginPath,
  )
  const manifestPath = join(extractedPath, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(
      `MCPB bundle "${params.source}" does not contain manifest.json`,
    )
  }

  const rawManifestJson: unknown = JSON.parse(
    await readFile(manifestPath, 'utf8'),
  )
  const mcpbMod = await loadMcpbModule()
  const parsedManifest = mcpbMod.vAny.McpbManifestSchema.safeParse(rawManifestJson)
  if (!parsedManifest.success) {
    throw new Error(
      `Invalid MCPB manifest in "${params.source}": ${parsedManifest.error.message}`,
    )
  }

  const manifest = parsedManifest.data
  if (!manifest.server) {
    throw new Error(
      `MCPB manifest "${manifest.name}" does not declare a server configuration`,
    )
  }

  const storedConfig = {
    ...loadMcpServerUserConfig(params.pluginId, manifest.name),
    ...(params.userConfigOverrides ?? {}),
  }

  const missingFields: string[] = []
  const validationErrors: string[] = []
  const userConfigSchema = (manifest.user_config ?? {}) as Record<
    string,
    {
      required?: boolean
      type?: string
      default?: unknown
      min?: number
      max?: number
    }
  >

  const effectiveUserConfig: Record<string, string | number | boolean | string[]> =
    {}
  for (const [key, opt] of Object.entries(userConfigSchema)) {
    const val =
      storedConfig[key] !== undefined
        ? storedConfig[key]
        : (opt.default as string | number | boolean | string[] | undefined)
    if (val === undefined || val === '') {
      if (opt.required) {
        missingFields.push(key)
      }
      continue
    }
    if (opt.type === 'number') {
      const num = typeof val === 'number' ? val : Number(val)
      if (!Number.isFinite(num)) {
        validationErrors.push(`${key} must be a number`)
        continue
      }
      if (opt.min !== undefined && num < opt.min) {
        validationErrors.push(`${key} must be >= ${opt.min}`)
      }
      if (opt.max !== undefined && num > opt.max) {
        validationErrors.push(`${key} must be <= ${opt.max}`)
      }
      effectiveUserConfig[key] = num
    } else {
      effectiveUserConfig[key] = val
    }
  }

  if (
    params.forceConfigDialog ||
    missingFields.length > 0 ||
    validationErrors.length > 0
  ) {
    return {
      status: 'needs-config',
      serverName: manifest.name,
      extractedPath,
      missingFields,
      validationErrors,
    }
  }

  const resolvedMcpCfg = await mcpbMod.getMcpConfigForManifest({
    manifest,
    extensionPath: extractedPath,
    systemDirs: getSystemDirectories() as unknown as Record<string, string>,
    userConfig: effectiveUserConfig,
    pathSeparator: process.platform === 'win32' ? '\\' : '/',
  })

  if (!resolvedMcpCfg) {
    throw new Error(
      `MCPB manifest "${manifest.name}" produced no compatible MCP server configuration for platform ${process.platform}`,
    )
  }

  const config: McpServerConfig = {
    type: 'stdio',
    command: resolvedMcpCfg.command,
    ...(resolvedMcpCfg.args ? { args: resolvedMcpCfg.args } : {}),
    ...(resolvedMcpCfg.env ? { env: resolvedMcpCfg.env } : {}),
  }

  return {
    status: 'loaded',
    serverName: manifest.name,
    config,
    userConfig: effectiveUserConfig,
  }
}
