import { join } from 'path'
import { getFsImplementation } from '../../fs_operations.js'
import { safeParseJson } from '../../json.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from '../managed_path.js'
import { type SettingsJson, SettingsSchema } from '../types.js'
import {
  filterInvalidPermissionRules,
  formatZodError,
  type ValidationError,
} from '../validation.js'
import { WINDOWS_REGISTRY_VALUE_NAME } from './constants.js'
import {
  fireRawRead,
  getMdmRawReadPromise,
  type RawReadResult,
  startMdmRawRead,
} from './raw_read.js'

export type MdmResult = {
  settings: SettingsJson
  errors: ValidationError[]
}

const EMPTY_RESULT: MdmResult = Object.freeze({
  settings: Object.freeze({}),
  errors: Object.freeze([]) as unknown as ValidationError[],
})

let cachedMdmResult: MdmResult = EMPTY_RESULT
let cachedHkcuResult: MdmResult = EMPTY_RESULT
let loadPromise: Promise<void> | null = null

export function parseRegQueryStdout(
  stdout: string,
  valueName: string = WINDOWS_REGISTRY_VALUE_NAME,
): string | null {
  const escaped = valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(
    `^\\s+${escaped}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`,
    'i',
  )
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(regex)
    if (match && match[1] !== undefined) {
      return match[1].trimEnd()
    }
  }
  return null
}

export function parseCommandOutputAsSettings(
  stdout: string,
  sourcePath: string,
): MdmResult {
  const parsed = safeParseJson(stdout, false)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      settings: {},
      errors: [
        {
          file: sourcePath,
          path: '',
          message: 'Managed MDM settings must be a valid JSON object',
        },
      ],
    }
  }

  const ruleErrors = filterInvalidPermissionRules(parsed, sourcePath)
  const validated = SettingsSchema().safeParse(parsed)
  if (!validated.success) {
    return {
      settings: {},
      errors: [...ruleErrors, ...formatZodError(validated.error, sourcePath)],
    }
  }

  return {
    settings: validated.data,
    errors: ruleErrors,
  }
}

function isNonEmptySettingsObject(filePath: string): boolean {
  try {
    const content = getFsImplementation().readFileSync(filePath, {
      encoding: 'utf-8',
    })
    const parsed = safeParseJson(content, false)
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.keys(parsed as Record<string, unknown>).length > 0
    )
  } catch {
    return false
  }
}

function hasManagedSettingsFile(): boolean {
  const fsImpl = getFsImplementation()
  const basePath = join(getManagedFilePath(), 'managed-settings.json')
  if (fsImpl.existsSync(basePath) && isNonEmptySettingsObject(basePath)) {
    return true
  }

  const dropInDir = getManagedSettingsDropInDir()
  try {
    const entries = fsImpl.readdirSync(dropInDir)
    for (const entry of entries) {
      if (entry.name.startsWith('.') || !entry.name.endsWith('.json')) continue
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      if (isNonEmptySettingsObject(join(dropInDir, entry.name))) {
        return true
      }
    }
  } catch {
    // Drop-in directory absent or unreadable
  }
  return false
}

function consumeRawReadResult(raw: RawReadResult): {
  mdm: MdmResult
  hkcu: MdmResult
} {
  if (raw.plistStdouts && raw.plistStdouts.length > 0) {
    const first = raw.plistStdouts[0]!
    return {
      mdm: parseCommandOutputAsSettings(first.stdout, first.label),
      hkcu: EMPTY_RESULT,
    }
  }

  if (raw.hklmStdout) {
    const value = parseRegQueryStdout(raw.hklmStdout)
    if (value) {
      return {
        mdm: parseCommandOutputAsSettings(value, 'Windows HKLM policy'),
        hkcu: EMPTY_RESULT,
      }
    }
  }

  if (hasManagedSettingsFile()) {
    return { mdm: EMPTY_RESULT, hkcu: EMPTY_RESULT }
  }

  if (raw.hkcuStdout) {
    const value = parseRegQueryStdout(raw.hkcuStdout)
    if (value) {
      return {
        mdm: EMPTY_RESULT,
        hkcu: parseCommandOutputAsSettings(value, 'Windows HKCU policy'),
      }
    }
  }

  return { mdm: EMPTY_RESULT, hkcu: EMPTY_RESULT }
}

export function startMdmSettingsLoad(): void {
  startMdmRawRead()
  if (!loadPromise) {
    const promise = getMdmRawReadPromise()
    loadPromise = promise
      ? promise.then(raw => {
          const { mdm, hkcu } = consumeRawReadResult(raw)
          cachedMdmResult = mdm
          cachedHkcuResult = hkcu
        })
      : Promise.resolve()
  }
}

export async function ensureMdmSettingsLoaded(): Promise<void> {
  if (!loadPromise) {
    startMdmSettingsLoad()
  }
  await loadPromise
}

export function getMdmSettings(): MdmResult {
  return cachedMdmResult
}

export function getHkcuSettings(): MdmResult {
  return cachedHkcuResult
}

export function clearMdmSettingsCache(): void {
  cachedMdmResult = EMPTY_RESULT
  cachedHkcuResult = EMPTY_RESULT
  loadPromise = null
}

export function setMdmSettingsCache(mdm: MdmResult, hkcu: MdmResult): void {
  cachedMdmResult = mdm
  cachedHkcuResult = hkcu
}

export async function refreshMdmSettings(): Promise<{
  mdm: MdmResult
  hkcu: MdmResult
}> {
  const raw = await fireRawRead()
  return consumeRawReadResult(raw)
}
