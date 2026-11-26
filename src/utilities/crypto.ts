/**
 * Explicit import-then-export of Node's randomUUID to avoid Bun bytecode
 * live-binding issues with direct `export { x } from 'crypto'`.
 */

import { randomUUID } from 'crypto'

export { randomUUID }
