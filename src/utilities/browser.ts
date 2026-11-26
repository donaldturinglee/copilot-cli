import { execFileNoThrow } from './exec_file_no_throw.js'

function validateUrl(url: string): void {
  let parsedUrl: URL

  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error(`Invalid URL format: ${url}`)
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `Invalid URL protocol: must use http:// or https://, got ${parsedUrl.protocol}`,
    )
  }
}

/**
 * Opens a file or folder path using the system default handler.
 */
export async function openPath(targetPath: string): Promise<boolean> {
  try {
    const platform = process.platform
    if (platform === 'win32') {
      const { code } = await execFileNoThrow('explorer', [targetPath])
      return code === 0
    }
    const command = platform === 'darwin' ? 'open' : 'xdg-open'
    const { code } = await execFileNoThrow(command, [targetPath])
    return code === 0
  } catch {
    return false
  }
}

/**
 * Opens an http(s) URL in the user's browser.
 */
export async function openBrowser(url: string): Promise<boolean> {
  try {
    validateUrl(url)

    const browserEnv = process.env.BROWSER
    const platform = process.platform

    if (platform === 'win32') {
      if (browserEnv) {
        const { code } = await execFileNoThrow(browserEnv, [`"${url}"`])
        return code === 0
      }
      const { code } = await execFileNoThrow(
        'rundll32',
        ['url,OpenURL', url],
        {},
      )
      return code === 0
    }

    const command = browserEnv || (platform === 'darwin' ? 'open' : 'xdg-open')
    const { code } = await execFileNoThrow(command, [url])
    return code === 0
  } catch {
    return false
  }
}
