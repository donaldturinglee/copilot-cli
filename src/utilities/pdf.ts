/**
 * PDF inspection, page counting, and base64 document / page-extraction reader.
 */

import { readFile, stat } from 'fs/promises'
import { execFileNoThrow } from './exec_file_no_throw.js'
import {
  LARGE_PDF_PAGE_THRESHOLD,
  MAX_PDF_FILE_SIZE_BYTES,
  parsePdfPageRange,
  type PdfPageRange,
} from './pdf_utils.js'
import { which } from './which.js'

export interface ReadPdfResult {
  type: 'pdf'
  filePath: string
  base64: string
  originalSize: number
  pageCount?: number
  pageRange?: PdfPageRange
}

let pdftoppmAvailableCache: boolean | undefined

export async function isPdftoppmAvailable(): Promise<boolean> {
  if (pdftoppmAvailableCache === undefined) {
    pdftoppmAvailableCache = Boolean(await which('pdftoppm'))
  }
  return pdftoppmAvailableCache
}

/**
 * Estimates PDF page count via `pdfinfo` if available, falling back to a fast
 * pure-TS scan of `/Type /Page` markers in the PDF buffer.
 */
export async function getPdfPageCount(
  filePath: string,
  buffer?: Buffer,
): Promise<number | undefined> {
  const pdfinfoPath = await which('pdfinfo')
  if (pdfinfoPath) {
    const res = await execFileNoThrow(pdfinfoPath, [filePath])
    if (res.code === 0) {
      const match = res.stdout.match(/^Pages:\s+(\d+)/m)
      if (match?.[1]) {
        return Number.parseInt(match[1], 10)
      }
    }
  }

  const data = buffer ?? (await readFile(filePath))
  const text = data.toString('latin1')
  // Match leaf `/Type /Page` (not `/Type /Pages`)
  const pageMatches = text.match(/\/Type\s*\/Page\b(?!s)/g)
  if (pageMatches && pageMatches.length > 0) {
    return pageMatches.length
  }
  // Fallback to `/Count N` inside root page tree
  const countMatches = Array.from(text.matchAll(/\/Count\s+(\d+)/g)).map(m =>
    Number.parseInt(m[1]!, 10),
  )
  if (countMatches.length > 0) {
    return Math.max(...countMatches)
  }
  return undefined
}

/**
 * Reads a PDF file, enforcing size ceilings and requiring explicit `pages`
 * pagination for large PDFs (> 10 pages) when `pages` is omitted.
 */
export async function readPdf(
  filePath: string,
  pages?: string,
): Promise<ReadPdfResult> {
  const stats = await stat(filePath)
  if (stats.size > MAX_PDF_FILE_SIZE_BYTES) {
    throw new Error(
      `PDF file (${Math.round(stats.size / (1024 * 1024))}MB) exceeds maximum supported size (${MAX_PDF_FILE_SIZE_BYTES / (1024 * 1024)}MB).`,
    )
  }

  let pageRange: PdfPageRange | undefined
  if (pages !== undefined) {
    const parsed = parsePdfPageRange(pages)
    if (!parsed.ok) {
      throw new Error(parsed.error)
    }
    pageRange = parsed.range
  }

  const buffer = await readFile(filePath)
  const pageCount = await getPdfPageCount(filePath, buffer)

  if (
    !pageRange &&
    pageCount !== undefined &&
    pageCount > LARGE_PDF_PAGE_THRESHOLD
  ) {
    throw new Error(
      `PDF has ${pageCount} pages. For PDFs larger than ${LARGE_PDF_PAGE_THRESHOLD} pages, specify the \`pages\` parameter (e.g. pages: "1-5", max 20 pages per call).`,
    )
  }

  if (pageRange && pageCount !== undefined && pageRange.start > pageCount) {
    throw new Error(
      `Requested page range ${pageRange.start}-${pageRange.end} starts past the end of the PDF (${pageCount} pages).`,
    )
  }

  return {
    type: 'pdf',
    filePath,
    base64: buffer.toString('base64'),
    originalSize: stats.size,
    ...(pageCount !== undefined ? { pageCount } : {}),
    ...(pageRange ? { pageRange } : {}),
  }
}
