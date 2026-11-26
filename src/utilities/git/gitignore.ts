/**
 * Gitignore inspection (`git check-ignore`) and safe `.gitignore` entry addition.
 */

import { appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getCwd } from '../cwd.js'
import { execFileNoThrowWithCwd } from '../exec_file_no_throw.js'
import { getFsImplementation } from '../fs_operations.js'

/**
 * Checks whether `filePath` is ignored by git (`git check-ignore -q`).
 * Fails open (`false`) on exit code 1 or 128 (not a git repository).
 */
export async function isPathGitignored(
  filePath: string,
  cwd: string = getCwd(),
): Promise<boolean> {
  const result = await execFileNoThrowWithCwd(
    'git',
    ['check-ignore', '-q', filePath],
    { cwd },
  )
  return result.code === 0
}

/**
 * Returns the default global gitignore path (`~/.config/git/ignore`).
 */
export function getGlobalGitignorePath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(xdgConfig, 'git', 'ignore')
}

/**
 * Appends a recursive glob rule for `filename` to `<cwd>/.gitignore` if not
 * already ignored.
 */
export async function addFileGlobRuleToGitignore(
  filename: string,
  cwd: string = getCwd(),
): Promise<boolean> {
  const targetPath = join(cwd, filename)
  if (await isPathGitignored(targetPath, cwd)) {
    return false
  }
  const gitignorePath = join(cwd, '.gitignore')
  const rule = `**/${filename}`
  const fsImpl = getFsImplementation()
  let needsLeadingNewline = false
  if (fsImpl.existsSync(gitignorePath)) {
    const existing = fsImpl.readFileSync(gitignorePath, { encoding: 'utf-8' })
    const existingLines = existing.split(/\r?\n/).map(line => line.trim())
    if (existingLines.includes(rule) || existingLines.includes(filename)) {
      return false
    }
    needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n')
  }
  appendFileSync(
    gitignorePath,
    `${needsLeadingNewline ? '\n' : ''}${rule}\n`,
    'utf-8',
  )
  return true
}
