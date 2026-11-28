import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { zipSync } from 'fflate'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getRegisteredHooks,
  resetStateForTests,
  setCwdState,
  setInlinePlugins,
  setProjectRoot,
} from '../../src/bootstrap/state.js'
import { loadOutputStyles } from '../../src/output_styles/load_output_styles_dir.js'
import {
  disablePluginOp,
  enablePluginOp,
  installPluginOp,
  uninstallPluginOp,
} from '../../src/services/plugins/plugin_operations.js'
import {
  getDefaultAppState,
  type AppState,
} from '../../src/state/app_state_store.js'
import { createStore } from '../../src/state/store.js'
import {
  extractZipToDirectory,
  isZipPathSafe,
  parseZipModes,
  unzipBuffer,
} from '../../src/utilities/dxt/zip.js'
import {
  resolveDependencyClosure,
  verifyAndDemote,
} from '../../src/utilities/plugins/dependency_resolver.js'
import { getInstalledPluginsV2 } from '../../src/utilities/plugins/installed_plugins_manager.js'
import {
  addMarketplace,
  listAllMarketplaces,
  removeMarketplace,
} from '../../src/utilities/plugins/marketplace_manager.js'
import { loadMcpbServer } from '../../src/utilities/plugins/mcpb_handler.js'
import {
  isBlockedOfficialName,
  validateOfficialNameSource,
} from '../../src/utilities/plugins/official_marketplace.js'
import {
  loadPluginOptions,
  saveMcpServerUserConfig,
  savePluginOptions,
  substituteUserConfigInContent,
} from '../../src/utilities/plugins/plugin_options_storage.js'
import { canUseMarketplaceSource } from '../../src/utilities/plugins/plugin_policy.js'
import {
  clearAllPluginCaches,
  refreshActivePlugins,
} from '../../src/utilities/plugins/refresh.js'
import { validateManifest } from '../../src/utilities/plugins/validate_plugin.js'
import { getSecureStorage } from '../../src/utilities/secure_storage/index.js'
import { getSettingsForSource } from '../../src/utilities/settings/settings.js'
import { resetSettingsCache } from '../../src/utilities/settings/settings_cache.js'

function injectUnixModeInPkzip(zipBytes: Uint8Array, mode: number): Uint8Array {
  const buf = Buffer.from(zipBytes)
  for (let i = 0; i <= buf.length - 46; i++) {
    if (buf.readUInt32LE(i) === 0x02014b50) {
      // Set versionMadeBy host OS = 3 (Unix)
      buf.writeUInt16LE((3 << 8) | 20, i + 4)
      buf.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, i + 38)
    }
  }
  return new Uint8Array(buf)
}

describe('Phase 8.3: Plugins, .mcpb/.dxt archives, and Marketplace governance', () => {
  let tempRoot: string
  let configDir: string
  let repoDir: string
  let savedConfigDir: string | undefined

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'copilot-phase8-plugins-'))
    configDir = join(tempRoot, 'copilot-config')
    repoDir = join(tempRoot, 'workspace')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(repoDir, { recursive: true })

    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir

    resetStateForTests()
    setCwdState(repoDir)
    setProjectRoot(repoDir)
    resetSettingsCache()
    clearAllPluginCaches()
  })

  afterEach(() => {
    setInlinePlugins([])
    clearAllPluginCaches()
    if (savedConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    }
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('enforces ZIP path traversal rejection, PKZIP Unix +x mode parsing, and .mcpb bundle loading', async () => {
    expect(isZipPathSafe('server/index.js')).toBe(true)
    expect(isZipPathSafe('../outside.sh')).toBe(false)
    expect(isZipPathSafe('/etc/passwd')).toBe(false)

    const traversalZip = zipSync({
      '../evil.txt': new TextEncoder().encode('pwn'),
    })
    await expect(unzipBuffer(traversalZip)).rejects.toThrow(/Unsafe archive/)

    // Valid .mcpb archive with Unix 0o755 executable bit and user_config
    const mcpbManifest = {
      manifest_version: '0.2',
      name: 'demo-bundle',
      version: '1.0.0',
      description: 'Bundled Node MCP extension',
      author: { name: 'Test Author' },
      server: {
        type: 'node',
        entry_point: 'server/index.js',
        mcp_config: {
          command: 'node',
          args: ['${__dirname}/server/index.js', '--token=${user_config.api_token}'],
        },
      },
      user_config: {
        api_token: {
          type: 'string',
          title: 'API Token',
          description: 'Secret token',
          required: true,
          sensitive: true,
        },
      },
    }

    const rawMcpb = zipSync({
      'manifest.json': new TextEncoder().encode(JSON.stringify(mcpbManifest)),
      'server/index.js': new TextEncoder().encode('console.log("ok")'),
    })
    const mcpbWithModes = injectUnixModeInPkzip(rawMcpb, 0o100755)
    const parsedModes = parseZipModes(mcpbWithModes)
    expect(parsedModes.get('server/index.js')).toBe(0o100755)

    const pluginDir = join(tempRoot, 'bundle-host-plugin')
    mkdirSync(pluginDir, { recursive: true })
    const bundlePath = join(pluginDir, 'demo.mcpb')
    writeFileSync(bundlePath, mcpbWithModes)

    // Without required user_config, returns needs-config
    const needsCfg = await loadMcpbServer({
      pluginId: 'bundle-host@local-mp',
      pluginPath: pluginDir,
      source: './demo.mcpb',
    })
    expect(needsCfg.status).toBe('needs-config')
    if (needsCfg.status === 'needs-config') {
      expect(needsCfg.missingFields).toEqual(['api_token'])
    }

    // Save sensitive user_config into SecureStorage and reload
    saveMcpServerUserConfig(
      'bundle-host@local-mp',
      'demo-bundle',
      { api_token: 'sec_xyz_999' },
      { api_token: { sensitive: true } },
    )
    const loaded = await loadMcpbServer({
      pluginId: 'bundle-host@local-mp',
      pluginPath: pluginDir,
      source: './demo.mcpb',
    })
    expect(loaded.status).toBe('loaded')
    if (loaded.status === 'loaded' && (!loaded.config.type || loaded.config.type === 'stdio')) {
      expect(loaded.config.command).toBe('node')
      expect(loaded.config.args?.some(a => a.includes('sec_xyz_999'))).toBe(true)
    }

    const extractTarget = join(tempRoot, 'extracted-test')
    const unzipped = await unzipBuffer(mcpbWithModes)
    await extractZipToDirectory(unzipped.files, extractTarget, unzipped.modes)
    expect(existsSync(join(extractTarget, 'manifest.json'))).toBe(true)
  })

  test('blocks official marketplace spoofing, splits sensitive userConfig into SecureStorage, and resolves dependencies', () => {
    expect(isBlockedOfficialName('official-claude-store')).toBe(true)
    expect(isBlockedOfficialName('clаude-official')).toBe(true) // Cyrillic 'а' homoglyph
    expect(isBlockedOfficialName('team-internal-tools')).toBe(false)

    // Claiming claude-plugins-official from non-anthropics repo is rejected
    expect(
      validateOfficialNameSource('claude-plugins-official', {
        source: 'github',
        repo: 'attacker/claude-plugins-official',
      }).valid,
    ).toBe(false)
    expect(
      validateOfficialNameSource('claude-plugins-official', {
        source: 'github',
        repo: 'anthropics/claude-plugins-official',
      }).valid,
    ).toBe(true)

    // Sensitive vs non-sensitive plugin userConfig storage split
    savePluginOptions(
      'acme@corp-mp',
      { endpoint: 'https://api.acme.internal', api_key: 'super-secret-token' },
      {
        endpoint: { sensitive: false },
        api_key: { sensitive: true },
      },
    )
    const userSettings = getSettingsForSource('userSettings')
    expect(userSettings?.pluginConfigs?.['acme@corp-mp']?.userConfig).toEqual({
      endpoint: 'https://api.acme.internal',
    })
    expect(
      getSecureStorage().read()?.pluginSecrets?.['acme@corp-mp']?.api_key,
    ).toBe('super-secret-token')
    expect(loadPluginOptions('acme@corp-mp')).toEqual({
      endpoint: 'https://api.acme.internal',
      api_key: 'super-secret-token',
    })
    expect(
      substituteUserConfigInContent(
        'Connect ${user_config.endpoint} with ${user_config.api_key}',
        loadPluginOptions('acme@corp-mp'),
      ),
    ).toBe('Connect https://api.acme.internal with super-secret-token')

    // Dependency closure & cross-marketplace block
    const graph: Record<string, { dependencies?: string[] }> = {
      'app@mp-a': { dependencies: ['core@mp-a'] },
      'core@mp-a': { dependencies: ['foreign@mp-b'] },
      'foreign@mp-b': {},
    }
    const blockedClosure = resolveDependencyClosure(
      'app@mp-a',
      id => graph[id] ?? null,
    )
    expect(blockedClosure.errors[0]?.reason).toBe('cross-marketplace-blocked')

    const validGraph: Record<string, { dependencies?: string[] }> = {
      'app@mp-a': { dependencies: ['core@mp-a'] },
      'core@mp-a': { dependencies: ['base@mp-a'] },
      'base@mp-a': {},
    }
    const okClosure = resolveDependencyClosure(
      'app@mp-a',
      id => validGraph[id] ?? null,
    )
    expect(okClosure.errors).toEqual([])
    expect(okClosure.closure).toEqual(['base@mp-a', 'core@mp-a', 'app@mp-a'])

    // Fixed-point demotion cascades when base dependency is missing
    const demoteErrors: import('../../src/types/plugin.js').PluginError[] = []
    const demoted = verifyAndDemote(
      [
        {
          name: 'app',
          source: 'app@mp-a',
          repository: 'app@mp-a',
          path: '/tmp/app',
          enabled: true,
          isBuiltin: false,
          manifest: { name: 'app', dependencies: ['missing-dep'] },
        },
      ],
      [],
      demoteErrors,
    )
    expect(demoted.enabled).toEqual([])
    expect(demoted.disabled.map(p => p.name)).toEqual(['app'])
    expect(demoteErrors[0]?.type).toBe('dependency-unsatisfied')
  })

  test('installs, loads all 7 component types, hot-reloads, disables, and uninstalls plugins from a local directory marketplace + --plugin-dir', async () => {
    const mpDir = join(tempRoot, 'company-marketplace')
    const pluginSrcDir = join(mpDir, 'plugins', 'fullstack-kit')
    mkdirSync(join(mpDir, '.copilot-plugin'), { recursive: true })
    mkdirSync(join(pluginSrcDir, '.copilot-plugin'), { recursive: true })
    mkdirSync(join(pluginSrcDir, 'commands'), { recursive: true })
    mkdirSync(join(pluginSrcDir, 'skills', 'lint-fix'), { recursive: true })
    mkdirSync(join(pluginSrcDir, 'agents'), { recursive: true })
    mkdirSync(join(pluginSrcDir, 'hooks'), { recursive: true })
    mkdirSync(join(pluginSrcDir, 'output-styles'), { recursive: true })

    writeFileSync(
      join(pluginSrcDir, '.copilot-plugin', 'plugin.json'),
      JSON.stringify(
        {
          name: 'fullstack-kit',
          version: '1.2.0',
          description: 'All-in-one fullstack plugin',
        },
        null,
        2,
      ),
      'utf8',
    )
    writeFileSync(
      join(pluginSrcDir, 'commands', 'deploy.md'),
      `---\ndescription: Deploy fullstack service\n---\nDeploy to $ARGUMENTS`,
      'utf8',
    )
    writeFileSync(
      join(pluginSrcDir, 'skills', 'lint-fix', 'SKILL.md'),
      `---\ndescription: Fix lint errors\n---\nRun linter in \${COPILOT_PLUGIN_ROOT}`,
      'utf8',
    )
    writeFileSync(
      join(pluginSrcDir, 'agents', 'reviewer.md'),
      `---\ndescription: Security reviewer subagent\nmodel: sonnet\n---\nYou are a strict reviewer.`,
      'utf8',
    )
    writeFileSync(
      join(pluginSrcDir, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'echo ${COPILOT_PLUGIN_ROOT}' }],
            },
          ],
        },
      }),
      'utf8',
    )
    writeFileSync(
      join(pluginSrcDir, 'output-styles', 'terse.md'),
      `---\nname: terse\ndescription: Ultra concise responses\n---\nReply in bullet points only.`,
      'utf8',
    )
    writeFileSync(
      join(pluginSrcDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          kitServer: {
            command: 'node',
            args: ['${COPILOT_PLUGIN_ROOT}/mcp.js'],
          },
        },
      }),
      'utf8',
    )
    writeFileSync(
      join(pluginSrcDir, '.lsp.json'),
      JSON.stringify({
        tsServer: {
          command: 'typescript-language-server',
          args: ['--stdio'],
          extensionToLanguage: { '.ts': 'typescript' },
        },
      }),
      'utf8',
    )

    writeFileSync(
      join(mpDir, '.copilot-plugin', 'marketplace.json'),
      JSON.stringify(
        {
          name: 'company-mp',
          owner: { name: 'Platform Team' },
          plugins: [
            {
              name: 'fullstack-kit',
              description: 'All-in-one fullstack plugin',
              version: '1.2.0',
              source: './plugins/fullstack-kit',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    // Validate both plugin and marketplace manifests
    expect(validateManifest(pluginSrcDir).valid).toBe(true)
    expect(validateManifest(mpDir).valid).toBe(true)
    expect(canUseMarketplaceSource({ source: 'directory', path: mpDir }).allowed).toBe(true)

    // Register local directory marketplace & install fullstack-kit
    const addedMp = await addMarketplace({ source: 'directory', path: mpDir })
    expect(addedMp.name).toBe('company-mp')
    expect(listAllMarketplaces().some(m => m.name === 'company-mp')).toBe(true)

    const installed = await installPluginOp('fullstack-kit@company-mp', 'user')
    expect(installed.pluginId).toBe('fullstack-kit@company-mp')
    expect(
      getInstalledPluginsV2(true).plugins['fullstack-kit@company-mp']?.[0]?.version,
    ).toBe('1.2.0')

    // Also attach a session-only --plugin-dir plugin
    const inlineDir = join(tempRoot, 'inline-dev-plugin')
    mkdirSync(join(inlineDir, '.copilot-plugin'), { recursive: true })
    mkdirSync(join(inlineDir, 'commands'), { recursive: true })
    writeFileSync(
      join(inlineDir, '.copilot-plugin', 'plugin.json'),
      JSON.stringify({ name: 'inline-helper', version: '0.1.0' }),
      'utf8',
    )
    writeFileSync(
      join(inlineDir, 'commands', 'ping.md'),
      `---\ndescription: Inline ping\n---\nPong!`,
      'utf8',
    )
    setInlinePlugins([inlineDir])

    const store = createStore<AppState>(getDefaultAppState())
    const summary = await refreshActivePlugins(store.setState)

    expect(summary.enabled.map(p => p.name)).toContain('fullstack-kit')
    expect(summary.enabled.map(p => p.name)).toContain('inline-helper')
    expect(summary.commands.map(c => c.name)).toContain('fullstack-kit:deploy')
    expect(summary.commands.map(c => c.name)).toContain('fullstack-kit:lint-fix')
    expect(summary.commands.map(c => c.name)).toContain('inline-helper:ping')
    expect(summary.agentCount).toBe(1)
    expect(summary.hookMatcherCount).toBe(1)
    expect(summary.mcpServerCount).toBe(1)
    expect(summary.lspServerCount).toBe(1)
    expect(getRegisteredHooks()?.PreToolUse?.length).toBe(1)

    const styles = loadOutputStyles({
      userConfigDir: configDir,
      projectDir: repoDir,
    })
    expect(styles['fullstack-kit:terse']).toBeDefined()

    // Disable -> Enable -> Uninstall lifecycle
    await disablePluginOp({
      rawSpec: 'fullstack-kit@company-mp',
      scope: 'user',
    })
    const afterDisable = await refreshActivePlugins(store.setState)
    expect(afterDisable.enabled.some(p => p.name === 'fullstack-kit')).toBe(false)
    expect(afterDisable.disabled.some(p => p.name === 'fullstack-kit')).toBe(true)

    await enablePluginOp('fullstack-kit@company-mp', 'user')
    const afterEnable = await refreshActivePlugins(store.setState)
    expect(afterEnable.enabled.some(p => p.name === 'fullstack-kit')).toBe(true)

    await uninstallPluginOp('fullstack-kit@company-mp', { scope: 'user' })
    expect(
      getInstalledPluginsV2(true).plugins['fullstack-kit@company-mp'],
    ).toBeUndefined()

    // Removing directory marketplace MUST NOT delete user-owned mpDir!
    expect(removeMarketplace('company-mp')).toBe(true)
    expect(existsSync(mpDir)).toBe(true)
  })
})
