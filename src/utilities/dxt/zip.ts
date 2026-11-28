/**
 * Safe synchronous ZIP extraction (`fflate` `unzipSync`) with zip-bomb ratios,
 * entry count/size ceilings, path-traversal guards, and PKZIP Central Directory
 * Unix permission mode (`+x`) restoration for `.mcpb` / `.dxt` / plugin archives.
 */

import { chmod, mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, isAbsolute, normalize, resolve, sep } from 'path'

export const MAX_ZIP_FILE_SIZE = 512 * 1024 * 1024 // 512 MB per entry
export const MAX_ZIP_TOTAL_SIZE = 1024 * 1024 * 1024 // 1 GB total uncompressed
export const MAX_ZIP_FILE_COUNT = 100_000
export const MAX_ZIP_COMPRESSION_RATIO = 50

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIR_SIGNATURE = 0x02014b50

/**
 * Returns true if `entryName` stays strictly relative without `..` or absolute
 * root escapes.
 */
export function isZipPathSafe(entryName: string): boolean {
  if (!entryName || entryName.includes('\0')) {
    return false
  }
  const normalized = normalize(entryName)
  if (isAbsolute(normalized) || entryName.startsWith('/') || entryName.startsWith('\\')) {
    return false
  }
  const segments = normalized.split(/[\\/]+/)
  return !segments.includes('..')
}

/**
 * Parses PKZIP Central Directory external file attributes to preserve Unix
 * executable modes (`0o755`, etc.) dropped by `fflate`.
 */
export function parseZipModes(data: Uint8Array): Map<string, number> {
  const modes = new Map<string, number>()
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (buf.length < 22) {
    return modes
  }

  let eocdOffset = -1
  const minOffset = Math.max(0, buf.length - 22 - 0xffff)
  for (let pos = buf.length - 22; pos >= minOffset; pos--) {
    if (buf.readUInt32LE(pos) === EOCD_SIGNATURE) {
      eocdOffset = pos
      break
    }
  }
  if (eocdOffset === -1) {
    return modes
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10)
  const cdOffset = buf.readUInt32LE(eocdOffset + 16)
  if (totalEntries === 0xffff || cdOffset === 0xffffffff) {
    return modes
  }

  let cursor = cdOffset
  for (let i = 0; i < totalEntries && cursor + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(cursor) !== CENTRAL_DIR_SIGNATURE) {
      break
    }
    const versionMadeBy = buf.readUInt16LE(cursor + 4)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const externalAttr = buf.readUInt32LE(cursor + 38)

    if (cursor + 46 + nameLen > buf.length) {
      break
    }
    const entryName = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8')
    const hostOs = (versionMadeBy >> 8) & 0xff
    if (hostOs === 3) {
      const unixMode = (externalAttr >>> 16) & 0xffff
      if (unixMode > 0) {
        modes.set(entryName, unixMode)
      }
    }
    cursor += 46 + nameLen + extraLen + commentLen
  }

  return modes
}

/**
 * Unzips `zipBytes` in memory after validating path safety and zip-bomb limits.
 */
export async function unzipBuffer(zipBytes: Uint8Array): Promise<{
  files: Record<string, Uint8Array>
  modes: Map<string, number>
}> {
  const { unzipSync } = await import('fflate')
  let fileCount = 0
  let cumulativeBytes = 0

  const files = unzipSync(zipBytes, {
    filter(file) {
      fileCount++
      if (fileCount > MAX_ZIP_FILE_COUNT) {
        throw new Error(
          `Archive exceeds maximum entry count (${MAX_ZIP_FILE_COUNT})`,
        )
      }
      if (!isZipPathSafe(file.name)) {
        throw new Error(`Unsafe archive entry path rejected: "${file.name}"`)
      }
      if (file.originalSize > MAX_ZIP_FILE_SIZE) {
        throw new Error(
          `Archive entry "${file.name}" exceeds 512MB uncompressed limit`,
        )
      }
      if (
        file.size > 0 &&
        file.originalSize / file.size > MAX_ZIP_COMPRESSION_RATIO &&
        file.originalSize > 1024 * 1024
      ) {
        throw new Error(
          `Suspicious compression ratio on "${file.name}" (zip-bomb guard)`,
        )
      }
      cumulativeBytes += file.originalSize
      if (cumulativeBytes > MAX_ZIP_TOTAL_SIZE) {
        throw new Error('Archive exceeds 1GB total uncompressed limit')
      }
      return true
    },
  })

  return {
    files,
    modes: parseZipModes(zipBytes),
  }
}

/**
 * Extracts validated `files` into `destDir`, restoring Unix executable bits.
 */
export async function extractZipToDirectory(
  files: Record<string, Uint8Array>,
  destDir: string,
  modes?: ReadonlyMap<string, number>,
): Promise<void> {
  const resolvedDest = resolve(destDir)
  await mkdir(resolvedDest, { recursive: true, mode: 0o755 })

  const entries = Object.entries(files)
  for (let i = 0; i < entries.length; i += 20) {
    const batch = entries.slice(i, i + 20)
    await Promise.all(
      batch.map(async ([entryName, content]) => {
        if (!isZipPathSafe(entryName)) {
          throw new Error(`Unsafe archive entry path rejected: "${entryName}"`)
        }
        const targetPath = resolve(resolvedDest, entryName)
        if (
          targetPath !== resolvedDest &&
          !targetPath.startsWith(`${resolvedDest}${sep}`)
        ) {
          throw new Error(`Archive entry escaped destination: "${entryName}"`)
        }
        if (entryName.endsWith('/')) {
          await mkdir(targetPath, { recursive: true })
          return
        }
        await mkdir(dirname(targetPath), { recursive: true })
        await writeFile(targetPath, content)
        const mode = modes?.get(entryName)
        if (mode !== undefined && (mode & 0o111) !== 0 && process.platform !== 'win32') {
          await chmod(targetPath, mode & 0o777).catch(() => {})
        }
      }),
    )
  }
}

/**
 * Reads a `.zip` / `.mcpb` / `.dxt` file from disk and extracts it into `destDir`.
 */
export async function unzipFileToDirectory(
  archivePath: string,
  destDir: string,
): Promise<void> {
  const buf = await readFile(archivePath)
  const { files, modes } = await unzipBuffer(
    new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
  )
  await extractZipToDirectory(files, destDir, modes)
}
