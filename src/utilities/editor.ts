import { spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export function resolveEditorCommand(): string | null {
  const candidate =
    process.env.VISUAL?.trim() ||
    process.env.EDITOR?.trim() ||
    (process.platform === 'win32' ? 'notepad' : 'vi')
  return candidate || null
}

export type ExternalEditorResult =
  | { ok: true; text: string }
  | { ok: false; error: string }

/**
 * Launch `$VISUAL` / `$EDITOR` on a temporary `.md` buffer pre-filled with
 * `initialText`, returning the updated content once the editor closes.
 */
export function launchExternalEditor(
  initialText: string,
  options?: {
    editorCommand?: string
    spawnFn?: typeof spawnSync
  },
): ExternalEditorResult {
  const editorCmd = options?.editorCommand ?? resolveEditorCommand()
  if (!editorCmd) {
    return { ok: false, error: 'No $VISUAL or $EDITOR configured.' }
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'copilot-editor-'))
  const filePath = join(tempDir, 'prompt.md')

  try {
    writeFileSync(filePath, initialText, 'utf8')
    const parts = editorCmd.split(/\s+/).filter(Boolean)
    const bin = parts[0]!
    const args = [...parts.slice(1), filePath]
    const runner = options?.spawnFn ?? spawnSync
    const res = runner(bin, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (res.error) {
      return { ok: false, error: res.error.message }
    }
    if (res.status !== 0 && res.status !== null) {
      return { ok: false, error: `Editor exited with code ${res.status}` }
    }
    const updated = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
    return { ok: true, text: updated }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // ignore temp cleanup errors
    }
  }
}
