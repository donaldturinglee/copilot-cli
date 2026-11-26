import { execFile } from 'child_process'
import { existsSync } from 'fs'
import {
  getMacosPlistPaths,
  MDM_SUBPROCESS_TIMEOUT_MS,
  PLUTIL_ARGS_PREFIX,
  PLUTIL_PATH,
  WINDOWS_REGISTRY_KEY_PATH_HKCU,
  WINDOWS_REGISTRY_KEY_PATH_HKLM,
  WINDOWS_REGISTRY_VALUE_NAME,
} from './constants.js'

export type RawReadResult = {
  plistStdouts: Array<{ stdout: string; label: string }> | null
  hklmStdout: string | null
  hkcuStdout: string | null
}

function execFileStdout(
  file: string,
  args: readonly string[],
): Promise<string | null> {
  return new Promise(resolve => {
    execFile(
      file,
      [...args],
      { encoding: 'utf-8', timeout: MDM_SUBPROCESS_TIMEOUT_MS },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(null)
          return
        }
        resolve(stdout)
      },
    )
  })
}

export async function fireRawRead(): Promise<RawReadResult> {
  if (process.platform === 'darwin') {
    const candidates = getMacosPlistPaths().filter(entry =>
      existsSync(entry.path),
    )
    if (candidates.length === 0) {
      return { plistStdouts: null, hklmStdout: null, hkcuStdout: null }
    }
    const results = await Promise.all(
      candidates.map(async entry => {
        const stdout = await execFileStdout(PLUTIL_PATH, [
          ...PLUTIL_ARGS_PREFIX,
          entry.path,
        ])
        return stdout ? { stdout, label: entry.label } : null
      }),
    )
    const valid = results.filter(
      (item): item is { stdout: string; label: string } => item !== null,
    )
    return {
      plistStdouts: valid.length > 0 ? valid : null,
      hklmStdout: null,
      hkcuStdout: null,
    }
  }

  if (process.platform === 'win32') {
    const [hklmStdout, hkcuStdout] = await Promise.all([
      execFileStdout('reg', [
        'query',
        WINDOWS_REGISTRY_KEY_PATH_HKLM,
        '/v',
        WINDOWS_REGISTRY_VALUE_NAME,
      ]),
      execFileStdout('reg', [
        'query',
        WINDOWS_REGISTRY_KEY_PATH_HKCU,
        '/v',
        WINDOWS_REGISTRY_VALUE_NAME,
      ]),
    ])
    return { plistStdouts: null, hklmStdout, hkcuStdout }
  }

  return { plistStdouts: null, hklmStdout: null, hkcuStdout: null }
}

let rawReadPromise: Promise<RawReadResult> | null = null

export function startMdmRawRead(): void {
  if (!rawReadPromise) {
    rawReadPromise = fireRawRead().catch(() => ({
      plistStdouts: null,
      hklmStdout: null,
      hkcuStdout: null,
    }))
  }
}

export function getMdmRawReadPromise(): Promise<RawReadResult> | null {
  return rawReadPromise
}

export function resetMdmRawReadForTesting(): void {
  rawReadPromise = null
}
