/**
 * Lazy loader for the optional native image processor module.
 */

import {
  loadNativeImageProcessor,
  type NativeImageProcessor,
} from '../../../native/image_processor/index.js'

let cachedProcessor: NativeImageProcessor | null | undefined

export function getImageProcessor(): NativeImageProcessor | null {
  if (cachedProcessor === undefined) {
    cachedProcessor = loadNativeImageProcessor()
  }
  return cachedProcessor
}
