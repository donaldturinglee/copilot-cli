import {
  type ExecSyncOptions,
  type ExecSyncOptionsWithBufferEncoding,
  type ExecSyncOptionsWithStringEncoding,
  execSync as nodeExecSync,
} from 'child_process'
import { slowLogging } from './slow_operations.js'

/**
 * Wrapped execSync with slow operation logging.
 * Use this instead of child_process execSync directly to detect performance issues.
 *
 * @deprecated Use async alternatives when possible. Sync exec calls block the event loop.
 */
export function execSyncDeprecated(command: string): Buffer
export function execSyncDeprecated(
  command: string,
  options: ExecSyncOptionsWithStringEncoding,
): string
export function execSyncDeprecated(
  command: string,
  options: ExecSyncOptionsWithBufferEncoding,
): Buffer
export function execSyncDeprecated(
  command: string,
  options?: ExecSyncOptions,
): Buffer | string
export function execSyncDeprecated(
  command: string,
  options?: ExecSyncOptions,
): Buffer | string {
  using slowOp = slowLogging`execSync: ${command.slice(0, 100)}`
  void slowOp
  return nodeExecSync(command, options)
}
