/**
 * Limits and binary/device guards for `FileReadTool` (`Read`).
 */

export const DEFAULT_READ_LINE_LIMIT = 2_000
export const MAX_LINE_DISPLAY_LENGTH = 2_000
export const DEFAULT_MAX_READ_BYTES = 256 * 1024 // 256 KB
export const MAX_READ_TOKENS = 25_000
export const CHARS_PER_TOKEN_ESTIMATE = 4
export const MAX_READ_CHARS_ESTIMATE = MAX_READ_TOKENS * CHARS_PER_TOKEN_ESTIMATE

export const BLOCKING_DEVICE_PATHS: ReadonlySet<string> = new Set([
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
])

export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.o',
  '.a',
  '.obj',
  '.class',
  '.jar',
  '.war',
  '.pyc',
  '.pyo',
  '.wasm',
  '.mp3',
  '.mp4',
  '.wav',
  '.flac',
  '.ogg',
  '.avi',
  '.mov',
  '.mkv',
  '.webm',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  '.ico',
  '.icns',
  '.bmp',
  '.tiff',
  '.psd',
  '.sqlite',
  '.db',
  '.parquet',
])

/**
 * Returns true if `filePath` targets a known blocking Unix device or stdio FD.
 */
export function isBlockingDevicePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  if (BLOCKING_DEVICE_PATHS.has(normalized)) {
    return true
  }
  return /^\/proc\/(?:\d+|self)\/fd\/[012]$/.test(normalized)
}

/**
 * Returns true if `filePath` is a Windows/POSIX UNC network path (`\\server\share`
 * or `//server/share`) that must not be probed directly.
 */
export function isUncPath(filePath: string): boolean {
  return filePath.startsWith('\\\\') || filePath.startsWith('//')
}
