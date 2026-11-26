import * as fs from 'fs'
import {
  mkdir as mkdirPromise,
  open,
  readdir as readdirPromise,
  readFile as readFilePromise,
  rename as renamePromise,
  rmdir as rmdirPromise,
  rm as rmPromise,
  stat as statPromise,
  unlink as unlinkPromise,
} from 'fs/promises'
import { homedir } from 'os'
import * as nodePath from 'path'
import { getErrnoCode } from './errors.js'
import { slowLogging } from './slow_operations.js'

const REVERSE_READ_CHUNK_SIZE = 1024 * 4

export type FsOperations = {
  cwd(): string
  existsSync(filePath: string): boolean
  stat(filePath: string): Promise<fs.Stats>
  readdir(dirPath: string): Promise<fs.Dirent[]>
  unlink(filePath: string): Promise<void>
  rmdir(dirPath: string): Promise<void>
  rm(
    filePath: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>
  mkdir(dirPath: string, options?: { mode?: number }): Promise<void>
  readFile(
    filePath: string,
    options: { encoding: BufferEncoding },
  ): Promise<string>
  rename(oldPath: string, newPath: string): Promise<void>
  statSync(filePath: string): fs.Stats
  lstatSync(filePath: string): fs.Stats
  readFileSync(
    filePath: string,
    options: {
      encoding: BufferEncoding
    },
  ): string
  readFileBytesSync(filePath: string): Buffer
  readSync(
    filePath: string,
    options: {
      length: number
    },
  ): {
    buffer: Buffer
    bytesRead: number
  }
  appendFileSync(
    filePath: string,
    data: string,
    options?: { mode?: number },
  ): void
  copyFileSync(src: string, dest: string): void
  unlinkSync(filePath: string): void
  renameSync(oldPath: string, newPath: string): void
  linkSync(target: string, filePath: string): void
  symlinkSync(
    target: string,
    filePath: string,
    type?: 'dir' | 'file' | 'junction',
  ): void
  readlinkSync(filePath: string): string
  realpathSync(filePath: string): string
  mkdirSync(
    dirPath: string,
    options?: {
      mode?: number
    },
  ): void
  readdirSync(dirPath: string): fs.Dirent[]
  readdirStringSync(dirPath: string): string[]
  isDirEmptySync(dirPath: string): boolean
  rmdirSync(dirPath: string): void
  rmSync(
    filePath: string,
    options?: {
      recursive?: boolean
      force?: boolean
    },
  ): void
  createWriteStream(filePath: string): fs.WriteStream
  readFileBytes(filePath: string, maxBytes?: number): Promise<Buffer>
}

/**
 * Safely resolves a file path, handling symlinks and errors gracefully.
 * Blocks UNC paths before filesystem access to prevent SMB/NTLM leakage on Windows.
 */
export function safeResolvePath(
  fsImpl: FsOperations,
  filePath: string,
): { resolvedPath: string; isSymlink: boolean; isCanonical: boolean } {
  if (filePath.startsWith('//') || filePath.startsWith('\\\\')) {
    return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  }

  try {
    const stats = fsImpl.lstatSync(filePath)
    if (
      stats.isFIFO() ||
      stats.isSocket() ||
      stats.isCharacterDevice() ||
      stats.isBlockDevice()
    ) {
      return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
    }

    const resolvedPath = fsImpl.realpathSync(filePath)
    return {
      resolvedPath,
      isSymlink: resolvedPath !== filePath,
      isCanonical: true,
    }
  } catch {
    return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  }
}

/**
 * Checks whether a path is a duplicate (after symlink resolution) and records it.
 */
export function isDuplicatePath(
  fsImpl: FsOperations,
  filePath: string,
  loadedPaths: Set<string>,
): boolean {
  const { resolvedPath } = safeResolvePath(fsImpl, filePath)
  if (loadedPaths.has(resolvedPath)) {
    return true
  }
  loadedPaths.add(resolvedPath)
  return false
}

/**
 * Resolves the deepest existing ancestor of a path via realpathSync, detecting
 * live and dangling symlinks so writes to non-existent targets can be checked.
 */
export function resolveDeepestExistingAncestorSync(
  fsImpl: FsOperations,
  absolutePath: string,
): string | undefined {
  let dir = absolutePath
  const segments: string[] = []
  while (dir !== nodePath.dirname(dir)) {
    let stats: fs.Stats
    try {
      stats = fsImpl.lstatSync(dir)
    } catch {
      segments.unshift(nodePath.basename(dir))
      dir = nodePath.dirname(dir)
      continue
    }
    if (stats.isSymbolicLink()) {
      try {
        const resolved = fsImpl.realpathSync(dir)
        return segments.length === 0
          ? resolved
          : nodePath.join(resolved, ...segments)
      } catch {
        const target = fsImpl.readlinkSync(dir)
        const absTarget = nodePath.isAbsolute(target)
          ? target
          : nodePath.resolve(nodePath.dirname(dir), target)
        return segments.length === 0
          ? absTarget
          : nodePath.join(absTarget, ...segments)
      }
    }
    try {
      const resolved = fsImpl.realpathSync(dir)
      if (resolved !== dir) {
        return segments.length === 0
          ? resolved
          : nodePath.join(resolved, ...segments)
      }
    } catch {
      // Ignore ancestor EACCES
    }
    return undefined
  }
  return undefined
}

/**
 * Collects all paths to check for permissions: the original path, every
 * intermediate symlink target in the chain, and the final resolved path.
 */
export function getPathsForPermissionCheck(inputPath: string): string[] {
  let targetPath = inputPath
  if (targetPath === '~') {
    targetPath = homedir().normalize('NFC')
  } else if (targetPath.startsWith('~/')) {
    targetPath = nodePath.join(homedir().normalize('NFC'), targetPath.slice(2))
  }

  const pathSet = new Set<string>()
  const fsImpl = getFsImplementation()
  pathSet.add(targetPath)

  if (targetPath.startsWith('//') || targetPath.startsWith('\\\\')) {
    return Array.from(pathSet)
  }

  try {
    let currentPath = targetPath
    const visited = new Set<string>()
    const maxDepth = 40

    for (let depth = 0; depth < maxDepth; depth++) {
      if (visited.has(currentPath)) {
        break
      }
      visited.add(currentPath)

      if (!fsImpl.existsSync(currentPath)) {
        if (currentPath === targetPath) {
          const resolved = resolveDeepestExistingAncestorSync(fsImpl, targetPath)
          if (resolved !== undefined) {
            pathSet.add(resolved)
          }
        }
        break
      }

      const stats = fsImpl.lstatSync(currentPath)
      if (
        stats.isFIFO() ||
        stats.isSocket() ||
        stats.isCharacterDevice() ||
        stats.isBlockDevice()
      ) {
        break
      }

      if (!stats.isSymbolicLink()) {
        break
      }

      const target = fsImpl.readlinkSync(currentPath)
      const absoluteTarget = nodePath.isAbsolute(target)
        ? target
        : nodePath.resolve(nodePath.dirname(currentPath), target)

      pathSet.add(absoluteTarget)
      currentPath = absoluteTarget
    }
  } catch {
    // Continue with collected paths
  }

  const { resolvedPath, isSymlink } = safeResolvePath(fsImpl, targetPath)
  if (isSymlink && resolvedPath !== targetPath) {
    pathSet.add(resolvedPath)
  }

  return Array.from(pathSet)
}

export const nodeFsOperations: FsOperations = {
  cwd() {
    return process.cwd()
  },

  existsSync(fsPath) {
    using slowOp = slowLogging`fs.existsSync(${fsPath})`
    void slowOp
    return fs.existsSync(fsPath)
  },

  async stat(fsPath) {
    return statPromise(fsPath)
  },

  async readdir(fsPath) {
    return readdirPromise(fsPath, { withFileTypes: true })
  },

  async unlink(fsPath) {
    return unlinkPromise(fsPath)
  },

  async rmdir(fsPath) {
    return rmdirPromise(fsPath)
  },

  async rm(fsPath, options) {
    return rmPromise(fsPath, options)
  },

  async mkdir(dirPath, options) {
    try {
      await mkdirPromise(dirPath, { recursive: true, ...options })
    } catch (error) {
      if (getErrnoCode(error) !== 'EEXIST') throw error
    }
  },

  async readFile(fsPath, options) {
    return readFilePromise(fsPath, { encoding: options.encoding })
  },

  async rename(oldPath, newPath) {
    return renamePromise(oldPath, newPath)
  },

  statSync(fsPath) {
    using slowOp = slowLogging`fs.statSync(${fsPath})`
    void slowOp
    return fs.statSync(fsPath)
  },

  lstatSync(fsPath) {
    using slowOp = slowLogging`fs.lstatSync(${fsPath})`
    void slowOp
    return fs.lstatSync(fsPath)
  },

  readFileSync(fsPath, options) {
    using slowOp = slowLogging`fs.readFileSync(${fsPath})`
    void slowOp
    return fs.readFileSync(fsPath, { encoding: options.encoding })
  },

  readFileBytesSync(fsPath) {
    using slowOp = slowLogging`fs.readFileBytesSync(${fsPath})`
    void slowOp
    return fs.readFileSync(fsPath)
  },

  readSync(fsPath, options) {
    using slowOp = slowLogging`fs.readSync(${fsPath}, ${options.length} bytes)`
    void slowOp
    let fd: number | undefined
    try {
      fd = fs.openSync(fsPath, 'r')
      const buffer = Buffer.alloc(options.length)
      const bytesRead = fs.readSync(fd, buffer, 0, options.length, 0)
      return { buffer, bytesRead }
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  },

  appendFileSync(filePath, data, options) {
    using slowOp = slowLogging`fs.appendFileSync(${filePath}, ${data.length} chars)`
    void slowOp
    if (options?.mode !== undefined) {
      try {
        const fd = fs.openSync(filePath, 'ax', options.mode)
        try {
          fs.appendFileSync(fd, data)
        } finally {
          fs.closeSync(fd)
        }
        return
      } catch (error) {
        if (getErrnoCode(error) !== 'EEXIST') throw error
      }
    }
    fs.appendFileSync(filePath, data)
  },

  copyFileSync(src, dest) {
    using slowOp = slowLogging`fs.copyFileSync(${src} -> ${dest})`
    void slowOp
    fs.copyFileSync(src, dest)
  },

  unlinkSync(filePath) {
    using slowOp = slowLogging`fs.unlinkSync(${filePath})`
    void slowOp
    fs.unlinkSync(filePath)
  },

  renameSync(oldPath, newPath) {
    using slowOp = slowLogging`fs.renameSync(${oldPath} -> ${newPath})`
    void slowOp
    fs.renameSync(oldPath, newPath)
  },

  linkSync(target, filePath) {
    using slowOp = slowLogging`fs.linkSync(${target} -> ${filePath})`
    void slowOp
    fs.linkSync(target, filePath)
  },

  symlinkSync(target, filePath, type) {
    using slowOp = slowLogging`fs.symlinkSync(${target} -> ${filePath})`
    void slowOp
    fs.symlinkSync(target, filePath, type)
  },

  readlinkSync(filePath) {
    using slowOp = slowLogging`fs.readlinkSync(${filePath})`
    void slowOp
    return fs.readlinkSync(filePath)
  },

  realpathSync(filePath) {
    using slowOp = slowLogging`fs.realpathSync(${filePath})`
    void slowOp
    return fs.realpathSync(filePath).normalize('NFC')
  },

  mkdirSync(dirPath, options) {
    using slowOp = slowLogging`fs.mkdirSync(${dirPath})`
    void slowOp
    const mkdirOptions: { recursive: boolean; mode?: number } = {
      recursive: true,
    }
    if (options?.mode !== undefined) {
      mkdirOptions.mode = options.mode
    }
    try {
      fs.mkdirSync(dirPath, mkdirOptions)
    } catch (error) {
      if (getErrnoCode(error) !== 'EEXIST') throw error
    }
  },

  readdirSync(dirPath) {
    using slowOp = slowLogging`fs.readdirSync(${dirPath})`
    void slowOp
    return fs.readdirSync(dirPath, { withFileTypes: true })
  },

  readdirStringSync(dirPath) {
    using slowOp = slowLogging`fs.readdirStringSync(${dirPath})`
    void slowOp
    return fs.readdirSync(dirPath)
  },

  isDirEmptySync(dirPath) {
    using slowOp = slowLogging`fs.isDirEmptySync(${dirPath})`
    void slowOp
    const files = this.readdirSync(dirPath)
    return files.length === 0
  },

  rmdirSync(dirPath) {
    using slowOp = slowLogging`fs.rmdirSync(${dirPath})`
    void slowOp
    fs.rmdirSync(dirPath)
  },

  rmSync(filePath, options) {
    using slowOp = slowLogging`fs.rmSync(${filePath})`
    void slowOp
    fs.rmSync(filePath, options)
  },

  createWriteStream(filePath) {
    return fs.createWriteStream(filePath)
  },

  async readFileBytes(fsPath, maxBytes) {
    if (maxBytes === undefined) {
      return readFilePromise(fsPath)
    }
    const handle = await open(fsPath, 'r')
    try {
      const { size } = await handle.stat()
      const readSize = Math.min(size, maxBytes)
      const buffer = Buffer.allocUnsafe(readSize)
      let offset = 0
      while (offset < readSize) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          readSize - offset,
          offset,
        )
        if (bytesRead === 0) break
        offset += bytesRead
      }
      return offset < readSize ? buffer.subarray(0, offset) : buffer
    } finally {
      await handle.close()
    }
  },
}

let activeFs: FsOperations = nodeFsOperations

export function setFsImplementation(implementation: FsOperations): void {
  activeFs = implementation
}

export function getFsImplementation(): FsOperations {
  return activeFs
}

export function setOriginalFsImplementation(): void {
  activeFs = nodeFsOperations
}

export type ReadFileRangeResult = {
  content: string
  bytesRead: number
  bytesTotal: number
}

/**
 * Reads up to `maxBytes` from a file starting at `offset`.
 * Returns null if the file is smaller than or equal to the offset.
 */
export async function readFileRange(
  filePath: string,
  offset: number,
  maxBytes: number,
): Promise<ReadFileRangeResult | null> {
  const fileHandle = await open(filePath, 'r')
  try {
    const size = (await fileHandle.stat()).size
    if (size <= offset) {
      return null
    }
    const bytesToRead = Math.min(size - offset, maxBytes)
    const buffer = Buffer.allocUnsafe(bytesToRead)

    let totalRead = 0
    while (totalRead < bytesToRead) {
      const { bytesRead } = await fileHandle.read(
        buffer,
        totalRead,
        bytesToRead - totalRead,
        offset + totalRead,
      )
      if (bytesRead === 0) {
        break
      }
      totalRead += bytesRead
    }

    return {
      content: buffer.toString('utf8', 0, totalRead),
      bytesRead: totalRead,
      bytesTotal: size,
    }
  } finally {
    await fileHandle.close()
  }
}

/**
 * Reads the last `maxBytes` of a file, or the whole file if smaller.
 */
export async function tailFile(
  filePath: string,
  maxBytes: number,
): Promise<ReadFileRangeResult> {
  const fileHandle = await open(filePath, 'r')
  try {
    const size = (await fileHandle.stat()).size
    if (size === 0) {
      return { content: '', bytesRead: 0, bytesTotal: 0 }
    }
    const offset = Math.max(0, size - maxBytes)
    const bytesToRead = size - offset
    const buffer = Buffer.allocUnsafe(bytesToRead)

    let totalRead = 0
    while (totalRead < bytesToRead) {
      const { bytesRead } = await fileHandle.read(
        buffer,
        totalRead,
        bytesToRead - totalRead,
        offset + totalRead,
      )
      if (bytesRead === 0) {
        break
      }
      totalRead += bytesRead
    }

    return {
      content: buffer.toString('utf8', 0, totalRead),
      bytesRead: totalRead,
      bytesTotal: size,
    }
  } finally {
    await fileHandle.close()
  }
}

/**
 * Async generator yielding lines from a file in reverse order without loading
 * the entire file into memory.
 */
export async function* readLinesReverse(
  filePath: string,
): AsyncGenerator<string, void, undefined> {
  const fileHandle = await open(filePath, 'r')
  try {
    const stats = await fileHandle.stat()
    let position = stats.size
    let remainder = Buffer.alloc(0)
    const buffer = Buffer.alloc(REVERSE_READ_CHUNK_SIZE)

    while (position > 0) {
      const currentChunkSize = Math.min(REVERSE_READ_CHUNK_SIZE, position)
      position -= currentChunkSize

      await fileHandle.read(buffer, 0, currentChunkSize, position)
      const combined = Buffer.concat([
        buffer.subarray(0, currentChunkSize),
        remainder,
      ])

      const firstNewline = combined.indexOf(0x0a)
      if (firstNewline === -1) {
        remainder = combined
        continue
      }

      remainder = Buffer.from(combined.subarray(0, firstNewline))
      const lines = combined.toString('utf8', firstNewline + 1).split('\n')

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!
        if (line) {
          yield line
        }
      }
    }

    if (remainder.length > 0) {
      yield remainder.toString('utf8')
    }
  } finally {
    await fileHandle.close()
  }
}
