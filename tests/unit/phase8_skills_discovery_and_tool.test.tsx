import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getInvokedSkillsForAgent,
  getSessionId,
  resetStateForTests,
  setAdditionalDirectoriesForClaudeMd,
  setCwdState,
  setProjectRoot,
} from '../../src/bootstrap/state.js'
import { clearCommandsCache, getCommands } from '../../src/commands.js'
import {
  bundledSkillToCommand,
  clearBundledSkillsForTesting,
  getBundledSkillCommands,
  resolveSkillFilePath,
} from '../../src/skills/bundled_skills.js'
import {
  initBundledSkills,
  resetBundledSkillsInitForTesting,
} from '../../src/skills/bundled/index.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  clearSkillCaches,
  discoverSkillDirsForPaths,
  getSkillDirCommands,
} from '../../src/skills/load_skills_dir.js'
import { getMcpSkillBuilders } from '../../src/skills/mcp_skill_builders.js'
import {
  getDefaultAppState,
  type AppState,
} from '../../src/state/app_state_store.js'
import { createStore } from '../../src/state/store.js'
import { formatCommandsWithinBudget } from '../../src/tools/skill_tool/prompt.js'
import { SkillTool } from '../../src/tools/skill_tool/skill_tool.js'
import type { ToolUseContext } from '../../src/tool.js'
import { getEmptyToolPermissionContext } from '../../src/types/permissions.js'
import { resetSettingsCache } from '../../src/utilities/settings/settings_cache.js'
import {
  disposeSkillChangeDetector,
  initializeSkillChangeDetector,
  onSkillsChanged,
  waitForSkillChangeDetectorReady,
} from '../../src/utilities/skills/skill_change_detector.js'

describe('Phase 8.2: Skills discovery, bundled extraction, SkillTool, and hot reload', () => {
  let tempRoot: string
  let configDir: string
  let repoDir: string
  let savedConfigDir: string | undefined
  let savedCharBudget: string | undefined

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'copilot-phase8-skills-'))
    configDir = join(tempRoot, 'copilot-config')
    repoDir = join(tempRoot, 'workspace')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(repoDir, { recursive: true })

    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    savedCharBudget = process.env.COPILOT_CLI_SKILL_CHAR_BUDGET
    process.env.CLAUDE_CONFIG_DIR = configDir

    resetStateForTests()
    setCwdState(repoDir)
    setProjectRoot(repoDir)
    resetSettingsCache()
    clearSkillCaches()
    clearCommandsCache()
    clearBundledSkillsForTesting()
    resetBundledSkillsInitForTesting()
  })

  afterEach(() => {
    disposeSkillChangeDetector()
    if (savedConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    }
    if (savedCharBudget === undefined) {
      delete process.env.COPILOT_CLI_SKILL_CHAR_BUDGET
    } else {
      process.env.COPILOT_CLI_SKILL_CHAR_BUDGET = savedCharBudget
    }
    clearSkillCaches()
    clearCommandsCache()
    clearBundledSkillsForTesting()
    resetBundledSkillsInitForTesting()
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('discovers user, project, --add-dir, and legacy commands/ skills with realpath symlink deduplication', async () => {
    const userSkillDir = join(configDir, 'skills', 'shared-audit')
    const projSkillDir = join(repoDir, '.copilot', 'skills', 'deploy-check')
    const legacyCmdDir = join(repoDir, '.copilot', 'commands')
    const extraWorkspace = join(tempRoot, 'extra-dir')
    const extraSkillDir = join(extraWorkspace, '.copilot', 'skills', 'extra-tool')

    mkdirSync(userSkillDir, { recursive: true })
    mkdirSync(projSkillDir, { recursive: true })
    mkdirSync(legacyCmdDir, { recursive: true })
    mkdirSync(extraSkillDir, { recursive: true })

    writeFileSync(
      join(userSkillDir, 'SKILL.md'),
      `---\ndescription: User audit workflow\n---\nAudit target: $ARGUMENTS`,
      'utf8',
    )
    writeFileSync(
      join(projSkillDir, 'SKILL.md'),
      `---\ndescription: Project deploy verification\nwhen_to_use: Before deploying\n---\nCheck deploy $0`,
      'utf8',
    )
    writeFileSync(
      join(legacyCmdDir, 'legacy-review.md'),
      `---\ndescription: Legacy command markdown\n---\nReview PR`,
      'utf8',
    )
    writeFileSync(
      join(extraSkillDir, 'SKILL.md'),
      `---\ndescription: Extra directory skill\n---\nRun extra`,
      'utf8',
    )

    // Create a symlinked duplicate of deploy-check if OS permits symlinks/junctions
    try {
      symlinkSync(
        projSkillDir,
        join(repoDir, '.copilot', 'skills', 'deploy-check-alias'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
    } catch {
      // Ignore if non-elevated Windows rejects symlink creation
    }

    setAdditionalDirectoriesForClaudeMd([extraWorkspace])
    const skills = await getSkillDirCommands(repoDir)
    const names = skills.map(s => s.name)

    expect(names).toContain('shared-audit')
    expect(names).toContain('deploy-check')
    expect(names).toContain('legacy-review')
    expect(names).toContain('extra-tool')
    // Symlink pointing to identical realpath SKILL.md is deduplicated
    expect(names.filter(n => n.startsWith('deploy-check')).length).toBe(1)
  })

  test('holds paths:-scoped conditional skills until matching files are accessed and lazily discovers nested .copilot/skills', async () => {
    const condDir = join(repoDir, '.copilot', 'skills', 'rust-safety')
    const nestedSkillDir = join(
      repoDir,
      'packages',
      'web',
      '.copilot',
      'skills',
      'frontend-a11y',
    )
    mkdirSync(condDir, { recursive: true })
    mkdirSync(nestedSkillDir, { recursive: true })

    writeFileSync(
      join(condDir, 'SKILL.md'),
      `---\ndescription: Rust unsafe block checklist\npaths: crates/**/*.rs\n---\nInspect unsafe blocks.`,
      'utf8',
    )
    writeFileSync(
      join(nestedSkillDir, 'SKILL.md'),
      `---\ndescription: Nested frontend accessibility skill\n---\nVerify ARIA attributes.`,
      'utf8',
    )

    const initial = await getSkillDirCommands(repoDir)
    expect(initial.some(s => s.name === 'rust-safety')).toBe(false)
    expect(initial.some(s => s.name === 'frontend-a11y')).toBe(false)

    // Non-matching path does not activate rust-safety
    expect(
      activateConditionalSkillsForPaths([join(repoDir, 'README.md')], repoDir),
    ).toEqual([])

    // Matching Rust path activates rust-safety
    const activated = activateConditionalSkillsForPaths(
      [join(repoDir, 'crates', 'core', 'lib.rs')],
      repoDir,
    )
    expect(activated).toEqual(['rust-safety'])

    // Touching packages/web/src/App.tsx discovers nested .copilot/skills
    const foundDirs = await discoverSkillDirsForPaths(
      [join(repoDir, 'packages', 'web', 'src', 'App.tsx')],
      repoDir,
    )
    expect(foundDirs.length).toBe(1)
    const added = await addSkillDirectories(foundDirs)
    expect(added).toEqual(['frontend-a11y'])

    const after = await getSkillDirCommands(repoDir)
    expect(after.some(s => s.name === 'rust-safety')).toBe(true)
    expect(after.some(s => s.name === 'frontend-a11y')).toBe(true)
  })

  test('expands variables and inline shell for trusted disk skills but NEVER executes inline shell for untrusted MCP skills', async () => {
    const skillDir = join(repoDir, '.copilot', 'skills', 'var-expand')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'description: Variable and shell test',
        'arguments: [envName, region]',
        '---',
        'Env=${envName} Region=$2 Dir=${COPILOT_SKILL_DIR} Session=${COPILOT_SESSION_ID} Echo=!`echo INLINE_OK`',
      ].join('\n'),
      'utf8',
    )

    const store = createStore<AppState>({
      ...getDefaultAppState(),
      toolPermissionContext: {
        ...getEmptyToolPermissionContext(),
        mode: 'bypassPermissions',
      },
    })
    const ctx: ToolUseContext = {
      abortController: new AbortController(),
      messages: [],
      getAppState: () => store.getState(),
      setAppState: store.setState,
    }

    const skills = await getSkillDirCommands(repoDir)
    const trusted = skills.find(s => s.name === 'var-expand')
    expect(trusted?.type).toBe('prompt')
    if (!trusted || trusted.type !== 'prompt') throw new Error('missing skill')

    const trustedBlocks = await trusted.getPromptForCommand('prod us-west', ctx)
    const trustedText =
      trustedBlocks[0]?.type === 'text' ? trustedBlocks[0].text : ''
    expect(trustedText).toContain('Env=prod Region=us-west')
    expect(trustedText).toContain(`Dir=${skillDir.replace(/\\/g, '/')}`)
    expect(trustedText).toContain(`Session=${getSessionId()}`)
    expect(trustedText).toContain('Echo=INLINE_OK')

    // Untrusted MCP prompt MUST NOT execute !`...` shell expressions
    const builders = getMcpSkillBuilders()!
    const untrustedMcpCmd = builders.createSkillCommand({
      name: 'mcp__evil__prompt',
      markdownContent: 'Payload: !`echo SHOULD_NOT_EXEC`',
      frontmatter: {
        description: 'Remote MCP prompt',
      },
      source: 'mcp',
      loadedFrom: 'mcp',
    })
    if (untrustedMcpCmd.type !== 'prompt') throw new Error('expected prompt')
    const mcpBlocks = await untrustedMcpCmd.getPromptForCommand('', ctx)
    const mcpText = mcpBlocks[0]?.type === 'text' ? mcpBlocks[0].text : ''
    expect(mcpText).toContain('!`echo SHOULD_NOT_EXEC`')
    expect(mcpText).not.toContain('SHOULD_NOT_EXEC\n')
  })

  test('extracts bundled skill reference files safely to temp dir and rejects path traversal', async () => {
    expect(() => resolveSkillFilePath('/tmp/root', '../escape.md')).toThrow(
      /traversal/,
    )
    expect(() => resolveSkillFilePath('/tmp/root', '/etc/passwd')).toThrow(
      /absolute/,
    )

    initBundledSkills()
    const bundled = getBundledSkillCommands()
    expect(bundled.length).toBeGreaterThanOrEqual(14)

    const verifyCmd = bundled.find(c => c.name === 'verify')
    expect(verifyCmd?.type).toBe('prompt')
    if (!verifyCmd || verifyCmd.type !== 'prompt') {
      throw new Error('verify bundled skill missing')
    }

    const blocks = await verifyCmd.getPromptForCommand('check auth module', {
      abortController: new AbortController(),
      messages: [],
    })
    const firstText = blocks[0]?.type === 'text' ? blocks[0].text : ''
    expect(firstText).toContain('Base directory for this skill:')
    const match = firstText.match(/Base directory for this skill:\s*(.+)/)
    const extractedDir = match?.[1]?.trim() ?? ''
    expect(existsSync(join(extractedDir, 'examples', 'cli.md'))).toBe(true)
    expect(existsSync(join(extractedDir, 'examples', 'server.md'))).toBe(true)
    expect(
      readFileSync(join(extractedDir, 'examples', 'cli.md'), 'utf8'),
    ).toContain('CLI Verification Checklist')
  })

  test('enforces 1% context budget while preserving full bundled skill descriptions and validates SkillTool inline execution + permissions', async () => {
    process.env.COPILOT_CLI_SKILL_CHAR_BUDGET = '220'

    const bundledCmd = bundledSkillToCommand({
      name: 'core-bundled',
      description:
        'Essential bundled verification workflow description that is never truncated',
      getPromptForCommand: async () => [{ type: 'text', text: 'bundled body' }],
    })

    const extraSkills = Array.from({ length: 6 }, (_, i) => ({
      ...bundledCmd,
      name: `custom-skill-${i}`,
      source: 'projectSettings' as const,
      loadedFrom: 'skills' as const,
      description:
        'A very long project skill description explaining detailed steps and context rules that must be truncated under tight char budget',
    }))

    const formatted = formatCommandsWithinBudget([bundledCmd, ...extraSkills])
    expect(formatted).toContain(
      '- core-bundled: Essential bundled verification workflow description that is never truncated',
    )
    expect(formatted).toContain('custom-skill-0')

    // Create a project skill with allowed-tools and model override and invoke via SkillTool
    const demoDir = join(repoDir, '.copilot', 'skills', 'demo-inline')
    mkdirSync(demoDir, { recursive: true })
    writeFileSync(
      join(demoDir, 'SKILL.md'),
      [
        '---',
        'description: Demo inline skill',
        'allowed-tools: Bash(git status:*), Read',
        'model: haiku',
        '---',
        'Execute inline task for $ARGUMENTS',
      ].join('\n'),
      'utf8',
    )

    const loadedCommands = await getCommands(repoDir)
    const store = createStore<AppState>({
      ...getDefaultAppState(),
      toolPermissionContext: {
        ...getEmptyToolPermissionContext(),
        alwaysAllowRules: {
          localSettings: ['Skill(demo-inline:*)'],
        },
      },
    })
    const toolCtx: ToolUseContext = {
      abortController: new AbortController(),
      messages: [],
      getAppState: () => store.getState(),
      setAppState: store.setState,
      options: {
        commands: loadedCommands,
        mainLoopModel: 'claude-sonnet-4-6',
      },
    }

    // Matching Skill(demo-inline:*) rule auto-allows privileged skill
    const perm = await SkillTool.checkPermissions(
      { skill: 'demo-inline', args: 'module-x' },
      toolCtx,
    )
    expect(perm.behavior).toBe('allow')

    const callRes = await SkillTool.call(
      { skill: 'demo-inline', args: 'module-x' },
      toolCtx,
      async () => ({ behavior: 'allow', updatedInput: { skill: 'demo-inline', args: 'module-x' } }),
      undefined,
    )
    expect(callRes.data.mode).toBe('inline')
    expect(callRes.newMessages?.length).toBe(1)

    // Verify invokedSkills state recorded for post-compaction preservation
    const recorded = getInvokedSkillsForAgent(null)
    const demoRecorded = Array.from(recorded.values()).find(
      s => s.skillName === 'demo-inline',
    )
    expect(demoRecorded?.content).toContain('Execute inline task for module-x')

    // Verify contextModifier applies allowedTools and model override
    const modifiedCtx = callRes.contextModifier!(toolCtx)
    expect(modifiedCtx.options?.mainLoopModel).toContain('haiku')
    expect(
      store.getState().toolPermissionContext.alwaysAllowRules.command,
    ).toEqual(['Bash(git status:*)', 'Read'])
  })

  test('chokidar skill_change_detector hot-reloads newly added .copilot/skills/demo/SKILL.md', async () => {
    mkdirSync(join(repoDir, '.copilot', 'skills'), { recursive: true })

    let changeCount = 0
    const unsub = onSkillsChanged(() => {
      changeCount++
    })
    initializeSkillChangeDetector(repoDir)
    await waitForSkillChangeDetectorReady()

    const hotDir = join(repoDir, '.copilot', 'skills', 'hot-demo')
    mkdirSync(hotDir, { recursive: true })
    writeFileSync(
      join(hotDir, 'SKILL.md'),
      `---\ndescription: Hot reloaded skill\n---\nHot skill body`,
      'utf8',
    )

    const deadline = Date.now() + 4_000
    while (changeCount === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
    }
    unsub()

    expect(changeCount).toBeGreaterThan(0)
    clearCommandsCache()
    const refreshed = await getCommands(repoDir)
    expect(refreshed.some(c => c.name === 'hot-demo')).toBe(true)
  })
})
