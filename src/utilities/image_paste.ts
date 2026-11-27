import type { ImageBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'

export const IMAGE_CHIP_RE = /\[Image #(\d+)\]/g

export type ImageMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'

export type StoredImagePaste = {
  id: number
  token: string
  mediaType: ImageMediaType
  base64Data: string
  width?: number
  height?: number
  sourcePath?: string
}

let nextImageId = 1
const imageMap = new Map<number, StoredImagePaste>()

export function registerImagePaste(params: {
  base64Data: string
  mediaType?: ImageMediaType
  width?: number
  height?: number
  sourcePath?: string
}): StoredImagePaste {
  const id = nextImageId++
  const item: StoredImagePaste = {
    id,
    token: `[Image #${id}]`,
    mediaType: params.mediaType ?? 'image/png',
    base64Data: params.base64Data,
    width: params.width,
    height: params.height,
    sourcePath: params.sourcePath,
  }
  imageMap.set(id, item)
  return item
}

export function getImagePaste(id: number): StoredImagePaste | undefined {
  return imageMap.get(id)
}

export function extractImagePasteIds(text: string): number[] {
  const ids: number[] = []
  const seen = new Set<number>()
  for (const m of text.matchAll(IMAGE_CHIP_RE)) {
    const id = Number(m[1])
    if (!Number.isNaN(id) && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

export function resolveImageBlocks(text: string): {
  imageIds: number[]
  blocks: ImageBlockParam[]
} {
  const imageIds = extractImagePasteIds(text)
  const blocks: ImageBlockParam[] = []
  for (const id of imageIds) {
    const stored = imageMap.get(id)
    if (!stored) continue
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: stored.mediaType,
        data: stored.base64Data,
      },
    })
  }
  return { imageIds, blocks }
}

export function clearImagePasteStore(): void {
  imageMap.clear()
  nextImageId = 1
}
