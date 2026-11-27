/**
 * Pure PDF extension, page-range parsing, and capability detection utilities.
 */

import { extname } from 'path'

export const MAX_PDF_PAGES_PER_READ = 20
export const LARGE_PDF_PAGE_THRESHOLD = 10
export const MAX_PDF_FILE_SIZE_BYTES = 32 * 1024 * 1024 // 32 MB

export interface PdfPageRange {
  start: number
  end: number
}

export function isPdfExtension(filePath: string): boolean {
  return extname(filePath).toLowerCase() === '.pdf'
}

export function isPdfSupported(): boolean {
  return true
}

/**
 * Parses a PDF page range string such as `"1-5"`, `"3"`, or `"10-20"`.
 * Rejects invalid formats, inverted ranges, non-positive pages, and ranges
 * exceeding `MAX_PDF_PAGES_PER_READ` (20).
 */
export function parsePdfPageRange(
  pages: string,
): { ok: true; range: PdfPageRange } | { ok: false; error: string } {
  const trimmed = pages.trim()
  const match = trimmed.match(/^(\d+)(?:\s*-\s*(\d+))?$/)
  if (!match) {
    return {
      ok: false,
      error: `Invalid pages parameter "${pages}". Expected a page number (e.g. "3") or range (e.g. "1-5").`,
    }
  }

  const start = Number.parseInt(match[1]!, 10)
  const end = match[2] ? Number.parseInt(match[2], 10) : start

  if (start < 1 || end < 1) {
    return {
      ok: false,
      error: `Page numbers must be >= 1 (received "${pages}").`,
    }
  }

  if (end < start) {
    return {
      ok: false,
      error: `Invalid page range "${pages}": end page (${end}) must be >= start page (${start}).`,
    }
  }

  const count = end - start + 1
  if (count > MAX_PDF_PAGES_PER_READ) {
    return {
      ok: false,
      error: `Requested ${count} pages (${pages}), which exceeds the maximum of ${MAX_PDF_PAGES_PER_READ} pages per read.`,
    }
  }

  return { ok: true, range: { start, end } }
}
