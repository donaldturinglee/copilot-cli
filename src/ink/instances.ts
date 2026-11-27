import type { Writable } from 'stream'

/**
 * WeakMap tracking active Ink instances per stdout stream so repeated mounts
 * cleanly reuse or tear down prior instances on the same stream.
 */
const instances = new WeakMap<Writable, unknown>()

export function getInkInstance<T>(stream: Writable): T | undefined {
  return instances.get(stream) as T | undefined
}

export function setInkInstance<T>(stream: Writable, instance: T): void {
  instances.set(stream, instance)
}

export function deleteInkInstance(stream: Writable): void {
  instances.delete(stream)
}
