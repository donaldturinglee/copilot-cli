import { lastGrapheme } from './intl.js'

let earlyInputBuffer = ''
let isCapturing = false
let readableHandler: (() => void) | null = null

function processChunk(text: string): void {
  let index = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)

    if (code === 3) {
      stopCapturingEarlyInput()
      process.exit(130)
      return
    }

    if (code === 4) {
      stopCapturingEarlyInput()
      return
    }

    if (code === 127 || code === 8) {
      const trailing = lastGrapheme(earlyInputBuffer)
      if (trailing) {
        earlyInputBuffer = earlyInputBuffer.slice(0, -trailing.length)
      }
      index++
      continue
    }

    if (code === 27) {
      index++
      while (index < text.length) {
        const nextCode = text.charCodeAt(index)
        index++
        if (nextCode >= 0x40 && nextCode <= 0x7e) {
          break
        }
      }
      continue
    }

    if (code === 13) {
      earlyInputBuffer += '\n'
      index++
      continue
    }

    if (code < 32 && code !== 9 && code !== 10) {
      index++
      continue
    }

    earlyInputBuffer += text[index]
    index++
  }
}

export function startCapturingEarlyInput(): void {
  if (
    !process.stdin.isTTY ||
    isCapturing ||
    process.argv.includes('-p') ||
    process.argv.includes('--print')
  ) {
    return
  }

  try {
    isCapturing = true
    earlyInputBuffer = ''
    process.stdin.setEncoding('utf8')
    process.stdin.setRawMode?.(true)
    process.stdin.ref?.()

    readableHandler = () => {
      let chunk: string | Buffer | null = process.stdin.read()
      while (chunk !== null) {
        processChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
        chunk = process.stdin.read()
      }
    }

    process.stdin.on('readable', readableHandler)
  } catch {
    isCapturing = false
    readableHandler = null
  }
}

export function stopCapturingEarlyInput(): void {
  if (readableHandler) {
    process.stdin.off('readable', readableHandler)
    readableHandler = null
  }
  isCapturing = false
}

export function consumeEarlyInput(): string {
  stopCapturingEarlyInput()
  const result = earlyInputBuffer.trim()
  earlyInputBuffer = ''
  return result
}

export function hasEarlyInput(): boolean {
  return earlyInputBuffer.trim().length > 0
}

export function seedEarlyInput(text: string): void {
  earlyInputBuffer = text
}

export function isCapturingEarlyInput(): boolean {
  return isCapturing
}
