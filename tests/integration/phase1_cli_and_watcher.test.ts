import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resetStateForTests,
  setOriginalCwd,
} from '../../src/bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../../src/utilities/env_utils.js'
import { settingsChangeDetector } from '../../src/utilities/settings/change_detector.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../src/utilities/settings/settings.js'
import { resetSettingsCache } from '../../src/utilities/settings/settings_cache.js'

const REPO_ROOT = process.cwd()
const CLI_ENTRY = join(REPO_ROOT, 'src', 'entrypoints', 'cli.tsx')

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await settingsChangeDetector.resetForTesting()
  resetStateForTests()
  resetSettingsCache()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Phase 1 CLI bootstrap integration', () => {
  test('cli.tsx --version exits 0 via zero-heavy-import fast path', async () => {
    const proc = Bun.spawn(['bun', 'run', CLI_ENTRY, '--version'], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.trim()).toBe('0.0.1 (Copilot CLI)')
  })

  test('cli.tsx --help exits 0 with sorted options and subcommands', async () => {
    const proc = Bun.spawn(['bun', 'run', CLI_ENTRY, '--help'], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('Usage: claude')
    expect(stdout).toContain('--bare')
    expect(stdout).toContain('--permission-mode')
    expect(stdout).toContain('Commands:')
    expect(stdout).toContain('mcp')
    expect(stdout).toContain('plugin')
  })

  test('cli.tsx --init-only initializes isolated config dir and exits 0', async () => {
    const isolatedConfigDir = makeTempDir('copilot-cli-init-only-')
    const proc = Bun.spawn(['bun', 'run', CLI_ENTRY, '--init-only'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        CLAUDE_CONFIG_DIR: isolatedConfigDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')

    const globalConfigPath = join(isolatedConfigDir, '.copilot.json')
    expect(existsSync(globalConfigPath)).toBe(true)
    const saved = JSON.parse(readFileSync(globalConfigPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(typeof saved.firstStartTime).toBe('string')
  })
})

describe('Phase 1 chokidar settings watcher integration', () => {
  test('detects external settings.json edits and suppresses self-initiated writes', async () => {
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    const tempRoot = makeTempDir('copilot-watcher-test-')
    const configDir = join(tempRoot, 'config')
    const projectDir = join(tempRoot, 'project')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(join(projectDir, '.copilot'), { recursive: true })

    const userSettingsPath = join(configDir, 'settings.json')
    writeFileSync(userSettingsPath, JSON.stringify({ model: 'initial' }), 'utf8')

    process.env.CLAUDE_CONFIG_DIR = configDir
    getClaudeConfigHomeDir.cache.clear?.()
    resetStateForTests()
    setOriginalCwd(projectDir)
    resetSettingsCache()

    try {
      await settingsChangeDetector.resetForTesting({
        stabilityThresholdMs: 50,
        pollIntervalMs: 25,
        deletionGraceMs: 150,
        internalWriteWindowMs: 5000,
      })

      const observedSources: string[] = []
      const unsubscribe = settingsChangeDetector.subscribe(source => {
        observedSources.push(source)
      })

      await settingsChangeDetector.initialize()
      // Give chokidar a brief moment to attach OS watchers
      await new Promise(resolve => setTimeout(resolve, 150))

      // 1. Self-initiated write via updateSettingsForSource should be suppressed
      updateSettingsForSource('userSettings', { model: 'self-written' })
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(observedSources).toEqual([])

      // 2. External write directly to settings.json must trigger reload callback
      writeFileSync(
        userSettingsPath,
        JSON.stringify({ model: 'external-hot-reload' }),
        'utf8',
      )

      const deadline = Date.now() + 3000
      while (observedSources.length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }

      expect(observedSources).toContain('userSettings')
      expect(getInitialSettings().model).toBe('external-hot-reload')
      unsubscribe()
    } finally {
      await settingsChangeDetector.dispose()
      if (savedConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = savedConfigDir
      }
      getClaudeConfigHomeDir.cache.clear?.()
    }
  })
})
