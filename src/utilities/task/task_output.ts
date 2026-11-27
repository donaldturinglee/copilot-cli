/**
 * Unified `TaskOutput` buffer supporting both symlink-safe disk FD streaming
 * and in-memory pipe accumulation, enforcing inline output length caps while
 * retaining full disk persistence for oversized command output.
 */

import { appendFileSync, readFileSync, statSync } from 'fs'
import { getMaxOutputLength } from '../shell/output_limits.js'
import {
  closeTaskOutputFd,
  createTaskOutputFile,
  generateTaskId,
  MAX_TASK_OUTPUT_BYTES,
  removeTaskOutputFile,
} from './disk_output.js'

export class TaskOutput {
  readonly taskId: string
  readonly path: string
  private fd: number | undefined
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private totalBytes = 0
  private spilledToDisk = false
  private closed = false

  constructor(taskId: string = generateTaskId(), openDiskFile = false) {
    this.taskId = taskId
    if (openDiskFile) {
      const created = createTaskOutputFile(taskId)
      this.fd = created.fd
      this.path = created.path
      this.spilledToDisk = true
    } else {
      const created = createTaskOutputFile(taskId)
      this.fd = created.fd
      this.path = created.path
    }
  }

  get fileDescriptor(): number | undefined {
    return this.fd
  }

  getTotalBytes(): number {
    if (this.spilledToDisk) {
      try {
        return Math.max(this.totalBytes, statSync(this.path).size)
      } catch {
        return this.totalBytes
      }
    }
    return this.totalBytes
  }

  exceedsMaxDiskSize(): boolean {
    return this.getTotalBytes() >= MAX_TASK_OUTPUT_BYTES
  }

  appendStdout(chunk: string): void {
    const byteLen = Buffer.byteLength(chunk, 'utf8')
    this.totalBytes += byteLen
    const maxInline = getMaxOutputLength() * 2
    if (this.stdoutBuffer.length < maxInline) {
      this.stdoutBuffer += chunk
    } else {
      this.spilledToDisk = true
    }
    this.writeToDisk(chunk)
  }

  appendStderr(chunk: string): void {
    const byteLen = Buffer.byteLength(chunk, 'utf8')
    this.totalBytes += byteLen
    const maxInline = getMaxOutputLength() * 2
    if (this.stderrBuffer.length < maxInline) {
      this.stderrBuffer += chunk
    } else {
      this.spilledToDisk = true
    }
    this.writeToDisk(chunk)
  }

  private writeToDisk(chunk: string): void {
    if (this.closed || this.totalBytes > MAX_TASK_OUTPUT_BYTES) {
      return
    }
    try {
      appendFileSync(this.path, chunk, 'utf8')
    } catch {
      // Best-effort disk spill
    }
  }

  getStdout(): string {
    if (this.stdoutBuffer.length > 0) {
      return this.stdoutBuffer
    }
    if (this.spilledToDisk) {
      try {
        return readFileSync(this.path, 'utf8')
      } catch {
        return ''
      }
    }
    return ''
  }

  getStderr(): string {
    return this.stderrBuffer
  }

  getCombinedOutput(): string {
    if (this.stdoutBuffer && this.stderrBuffer) {
      return `${this.stdoutBuffer}\n${this.stderrBuffer}`
    }
    return this.stdoutBuffer || this.stderrBuffer || this.getStdout()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    closeTaskOutputFd(this.fd)
    this.fd = undefined
  }

  cleanup(): void {
    this.close()
    removeTaskOutputFile(this.path)
  }
}
