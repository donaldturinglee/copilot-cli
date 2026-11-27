/**
 * Optional native N-API image processor bridge.
 * Falls back cleanly to `null` when native binaries are not compiled in the
 * current workspace so pure TypeScript header parsing and pass-through remain
 * operational on every platform.
 */

export interface NativeResizeResult {
  buffer: Buffer
  width: number
  height: number
  format: 'jpeg' | 'png' | 'webp' | 'gif'
}

export interface NativeImageProcessor {
  resize(
    input: Buffer,
    options: { maxWidth: number; maxHeight: number; quality?: number },
  ): Promise<NativeResizeResult> | NativeResizeResult
}

export function loadNativeImageProcessor(): NativeImageProcessor | null {
  return null
}
