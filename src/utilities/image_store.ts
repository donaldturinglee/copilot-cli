/**
 * Session-scoped LRU store of resized/decoded image metadata indexed by file
 * path or paste ID.
 */

import { LRUCache } from 'lru-cache'
import type { ImageDimensions } from '../types/forward.js'
import type { SupportedImageMediaType } from './image_validation.js'

export interface StoredImageRecord {
  base64: string
  mediaType: SupportedImageMediaType
  dimensions?: ImageDimensions
  originalSizeBytes: number
}

const imageStore = new LRUCache<string, StoredImageRecord>({
  max: 50,
  maxSize: 50 * 1024 * 1024,
  sizeCalculation: value => Math.max(1, value.base64.length),
})

export function getStoredImage(key: string): StoredImageRecord | undefined {
  return imageStore.get(key)
}

export function setStoredImage(key: string, record: StoredImageRecord): void {
  imageStore.set(key, record)
}

export function clearImageStore(): void {
  imageStore.clear()
}
