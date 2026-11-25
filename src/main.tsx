import {
  Command,
  InvalidArgumentError,
  Option,
} from '@commander-js/extra-typings'
import { resolve } from 'path'
import {
  setAllowedSettingSources,
  setChromeFlagOverride,
  setClientType,
  setFlagSettingsPath,
  setInlinePlugins,
  setIsInteractive,
  setQuestionPreviewFormat,
  setSessionBypassPermissionsMode,
  setSessionPersistenceDisabled,
  setSessionSource,
} from './bootstrap/state.js'
import { cliError } from './cli/exit.js'
import { init, initializeTelemetryAfterTrust } from './entrypoints/init.js'
import { migrateAutoUpdatesToSettings } from './migrations/migrate_auto_updates_to_settings.js'
import { migrateBypassPermissionsAcceptedToSettings } from './migrations/migrate_bypass_permissions_accepted_to_settings.js'
import { migrateEnableAllProjectMcpServersToSettings } from './migrations/migrate_enable_all_project_mcp_servers_to_settings.js'
import { migrateFennecToOpus } from './migrations/migrate_fennec_to_opus.js'
import { migrateLegacyOpusToCurrent } from './migrations/migrate_legacy_opus_to_current.js'
import { migrateOpusToOpus1m } from './migrations/migrate_opus_to_opus_1m.js'
import { migrateReplBridgeEnabledToRemoteControlAtStartup } from './migrations/migrate_repl_bridge_enabled_to_remote_control_at_startup.js'
import { migrateSonnet1mToSonnet45 } from './migrations/migrate_sonnet_1m_to_sonnet_45.js'
import { migrateSonnet45ToSonnet46 } from './migrations/migrate_sonnet_45_to_sonnet_46.js'
import { resetAutoModeOptInForDefaultOffer } from './migrations/reset_auto_mode_opt_in_for_default_offer.js'
import { resetProToOpusDefault } from './migrations/reset_pro_to_opus_default.js'
import { setup } from './setup.js'
import { PERMISSION_MODES, type PermissionMode } from './types/permissions.js'
import { eagerParseCliFlag } from './utils/cli_args.js'
import { getCwd } from './utils/cwd.js'
import { setHasFormattedOutput } from './utils/debug.js'
import { seedEarlyInput, stopCapturingEarlyInput } from './utils/early_input.js'
import { isBareMode, isEnvTruthy } from './utils/env_utils.js'
import { ensureMacroGlobals, isFeatureEnabled } from './utils/feature_flags.js'
import { getFsImplementation } from './utils/fs_operations.js'
import {
  gracefulShutdown,
  gracefulShutdownSync,
} from './utils/graceful_shutdown.js'
import { applyConfigEnvironmentVariables } from './utils/managed_env.js'
import { peekForStdinData } from './utils/process.js'
import { parseSettingSourcesFlag } from './utils/settings/constants.js'
import { startMdmRawRead } from './utils/settings/mdm/raw_read.js'
import { ensureMdmSettingsLoaded } from './utils/settings/mdm/settings.js'
import { resetSettingsCache } from './utils/settings/settings_cache.js'
import { writeFileSyncDeprecated } from './utils/slow_operations.js'
import { profileCheckpoint, profileReport } from './utils/startup_profiler.js'
import { generateTempFilePath } from './utils/tempfile.js'
import { validateUuid } from './utils/uuid.js'
import { initializeWarningHandler } from './utils/warning_handler.js'
import { runWithWorkload } from './utils/workload_context.js'

ensureMacroGlobals()
profileCheckpoint('main_tsx_entry')
startMdmRawRead()
profileCheckpoint('main_tsx_imports_loaded')

const SHOW_CURSOR = '\x1b[?25h'
const VALID_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const

export type MainRuntimeHooks = {
  onDeferredPrefetches?: () => void
  onInitSinks?: () => void
  onSetupAndSessionStartHooks?: () => Promise<void>
  onHeadlessRun?: (
    prompt: string,
    options: Record<string, unknown>,
  ) => Promise<void>
  onInteractiveRun?: (
    prompt: string,
    options: Record<string, unknown>,
  ) => Promise<void>
  subcommandHandlers?: Record<string, (...args: unknown[]) => Promise<void>>
}

let runtimeHooks: MainRuntimeHooks = {}

export function registerMainRuntimeHooks(
  hooks: Partial<MainRuntimeHooks>,
): void {
  runtimeHooks = {
    ...runtimeHooks,
    ...hooks,
    subcommandHandlers: {
      ...runtimeHooks.subcommandHandlers,
      ...hooks.subcommandHandlers,
    },
  }
}

export function startDeferredPrefetches(): void {
  if (
    isEnvTruthy(process.env.COPILOT_CLI_EXIT_AFTER_FIRST_RENDER) ||
    isBareMode()
  ) {
    return
  }
  runtimeHooks.onDeferredPrefetches?.()
}

function getMacroVersion(): string {
  const macroGlobal = (
    globalThis as unknown as { MACRO?: { VERSION?: string } }
  ).MACRO
  return macroGlobal?.VERSION ?? '0.0.1'
}

function resetCursor(): void {
  if (process.stderr.isTTY) {
    process.stderr.write(SHOW_CURSOR)
  } else if (process.stdout.isTTY) {
    process.stdout.write(SHOW_CURSOR)
  }
}

function initializeEntrypoint(isNonInteractive: boolean): void {
  if (process.env.COPILOT_CLI_ENTRYPOINT) {
    return
  }
  const args = process.argv.slice(2)
  if (args[0] === 'mcp' && args[1] === 'serve') {
    process.env.COPILOT_CLI_ENTRYPOINT = 'mcp'
    return
  }
  if (isEnvTruthy(process.env.COPILOT_CLI_ACTION)) {
    process.env.COPILOT_CLI_ENTRYPOINT = 'claude-code-github-action'
    return
  }
  process.env.COPILOT_CLI_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli'
}

function determineClientType(isNonInteractive: boolean): void {
  const entrypoint = process.env.COPILOT_CLI_ENTRYPOINT
  if (isEnvTruthy(process.env.COPILOT_CLI_ACTION)) {
    setClientType('github-action')
  } else if (entrypoint === 'sdk-ts') {
    setClientType('sdk-typescript')
  } else if (entrypoint === 'sdk-py') {
    setClientType('sdk-python')
  } else if (entrypoint === 'claude-vscode') {
    setClientType('claude-vscode')
  } else if (entrypoint === 'local-agent') {
    setClientType('local-agent')
  } else if (entrypoint === 'claude-desktop') {
    setClientType('claude-desktop')
  } else if (isEnvTruthy(process.env.COPILOT_CLI_REMOTE)) {
    setClientType('remote')
  } else if (isNonInteractive || entrypoint === 'sdk-cli') {
    setClientType('sdk-cli')
  } else {
    setClientType('cli')
  }

  const previewFormat = process.env.COPILOT_CLI_QUESTION_PREVIEW_FORMAT
  if (previewFormat === 'markdown' || previewFormat === 'html') {
    setQuestionPreviewFormat(previewFormat)
  }

  if (process.env.COPILOT_CLI_ENVIRONMENT_KIND === 'bridge') {
    setSessionSource('remote-control')
  }
}

function eagerLoadSettings(argv: string[] = process.argv): void {
  profileCheckpoint('eagerLoadSettings_start')
  try {
    const settingsArg = eagerParseCliFlag('--settings', argv)
    if (settingsArg) {
      const trimmed = settingsArg.trim()
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const tempPath = generateTempFilePath('claude-flag-settings', '.json', {
          contentHash: trimmed,
        })
        writeFileSyncDeprecated(tempPath, trimmed, { encoding: 'utf-8' })
        setFlagSettingsPath(tempPath)
      } else {
        setFlagSettingsPath(resolve(getCwd(), trimmed))
      }
      resetSettingsCache()
    }

    const settingSourcesArg = eagerParseCliFlag('--setting-sources', argv)
    if (settingSourcesArg !== undefined) {
      const sources = parseSettingSourcesFlag(settingSourcesArg)
      setAllowedSettingSources(sources)
      resetSettingsCache()
    }
  } finally {
    profileCheckpoint('eagerLoadSettings_end')
  }
}

function runSyncMigrations(): void {
  migrateAutoUpdatesToSettings()
  migrateBypassPermissionsAcceptedToSettings()
  migrateEnableAllProjectMcpServersToSettings()
  migrateFennecToOpus()
  migrateLegacyOpusToCurrent()
  migrateOpusToOpus1m()
  migrateReplBridgeEnabledToRemoteControlAtStartup()
  migrateSonnet1mToSonnet45()
  migrateSonnet45ToSonnet46()
  resetAutoModeOptInForDefaultOffer()
  resetProToOpusDefault()
}

function sortKeyForOption(option: Option): string {
  return option.long?.replace(/^--/, '') ?? option.short?.replace(/^-/, '') ?? ''
}

function createSortedHelpConfig(): {
  sortSubcommands: boolean
  sortOptions: boolean
  compareOptions: (first: Option, second: Option) => number
} {
  return {
    sortSubcommands: true,
    sortOptions: true,
    compareOptions: (first: Option, second: Option) =>
      sortKeyForOption(first).localeCompare(sortKeyForOption(second)),
  }
}

function parsePositiveNumber(rawValue: string): number {
  const parsed = Number(rawValue)
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`Expected a positive number, got "${rawValue}"`)
  }
  return parsed
}

function parsePositiveInteger(rawValue: string): number {
  const parsed = Number(rawValue)
  if (Number.isNaN(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new InvalidArgumentError(
      `Expected a positive integer, got "${rawValue}"`,
    )
  }
  return parsed
}

function parseEffortLevel(rawValue: string): string {
  const normalized = rawValue.toLowerCase()
  if (!(VALID_EFFORT_LEVELS as readonly string[]).includes(normalized)) {
    throw new InvalidArgumentError(
      `Invalid effort level "${rawValue}". Valid values: ${VALID_EFFORT_LEVELS.join(', ')}`,
    )
  }
  return normalized
}

async function readPipedStdin(inputFormat: string): Promise<string> {
  if (process.stdin.isTTY || inputFormat === 'stream-json') {
    return ''
  }
  const timedOut = await peekForStdinData(process.stdin, 3000)
  if (timedOut) {
    return ''
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

function registerSubcommands<
  Args extends unknown[],
  Opts extends Record<string, unknown>,
>(program: Command<Args, Opts>): void {
  const dispatchSubcommand = (name: string) => async (...args: unknown[]) => {
    const handler = runtimeHooks.subcommandHandlers?.[name]
    if (handler) {
      await handler(...args)
      return
    }
    cliError(`Subcommand "${name}" is not implemented in this phase.`)
  }

  program
    .command('agents')
    .description('List configured agents')
    .option('--setting-sources <sources>', 'Setting sources to load')
    .action(dispatchSubcommand('agents'))

  const authCommand = program
    .command('auth')
    .description('Manage authentication')
  authCommand
    .command('login')
    .description('Sign in to your account')
    .option('--email <email>', 'Pre-fill email address')
    .option('--sso', 'Sign in with SSO')
    .option('--console', 'Authenticate with Anthropic Console')
    .option('--claudeai', 'Authenticate with Claude.ai')
    .action(dispatchSubcommand('auth:login'))
  authCommand
    .command('logout')
    .description('Sign out of your account')
    .action(dispatchSubcommand('auth:logout'))
  authCommand
    .command('status')
    .description('Show authentication status')
    .option('--json', 'Output JSON')
    .option('--text', 'Output human-readable text')
    .action(dispatchSubcommand('auth:status'))

  program
    .command('doctor')
    .description('Check the health of your installation')
    .action(dispatchSubcommand('doctor'))

  program
    .command('install [target]')
    .description('Install native build')
    .option('--force', 'Force reinstall')
    .action(dispatchSubcommand('install'))

  const mcpCommand = program
    .command('mcp')
    .description('Configure and manage MCP servers')
  mcpCommand
    .command('serve')
    .description('Start an MCP server')
    .option('-d, --debug', 'Enable debug mode')
    .option('--verbose', 'Enable verbose logging')
    .action(dispatchSubcommand('mcp:serve'))
  mcpCommand
    .command('add <name> <commandOrUrl> [args...]')
    .description('Add an MCP server')
    .option('-s, --scope <scope>', 'Configuration scope')
    .action(dispatchSubcommand('mcp:add'))
  mcpCommand
    .command('remove <name>')
    .description('Remove an MCP server')
    .option('-s, --scope <scope>', 'Configuration scope')
    .action(dispatchSubcommand('mcp:remove'))
  mcpCommand
    .command('list')
    .description('List configured MCP servers')
    .action(dispatchSubcommand('mcp:list'))
  mcpCommand
    .command('get <name>')
    .description('Get details for an MCP server')
    .action(dispatchSubcommand('mcp:get'))
  mcpCommand
    .command('add-json <name> <json>')
    .description('Add an MCP server from a JSON string')
    .option('-s, --scope <scope>', 'Configuration scope')
    .option('--client-secret <secret>', 'OAuth client secret')
    .action(dispatchSubcommand('mcp:add-json'))
  mcpCommand
    .command('add-from-claude-desktop')
    .description('Import MCP servers from Claude Desktop')
    .option('-s, --scope <scope>', 'Configuration scope')
    .action(dispatchSubcommand('mcp:add-from-claude-desktop'))
  mcpCommand
    .command('reset-project-choices')
    .description('Reset approved and rejected project-scoped MCP servers')
    .action(dispatchSubcommand('mcp:reset-project-choices'))

  const pluginCommand = program
    .command('plugin')
    .alias('plugins')
    .description('Manage plugins')
  pluginCommand
    .command('validate <path>')
    .description('Validate a plugin manifest')
    .action(dispatchSubcommand('plugin:validate'))
  pluginCommand
    .command('list')
    .description('List installed plugins')
    .option('--json', 'Output JSON')
    .option('--available', 'Include available plugins')
    .action(dispatchSubcommand('plugin:list'))
  pluginCommand
    .command('install <plugin>')
    .alias('i')
    .description('Install a plugin')
    .action(dispatchSubcommand('plugin:install'))
  pluginCommand
    .command('uninstall <plugin>')
    .alias('remove')
    .alias('rm')
    .description('Uninstall a plugin')
    .action(dispatchSubcommand('plugin:uninstall'))
  pluginCommand
    .command('enable <plugin>')
    .description('Enable a plugin')
    .action(dispatchSubcommand('plugin:enable'))
  pluginCommand
    .command('disable [plugin]')
    .description('Disable a plugin')
    .action(dispatchSubcommand('plugin:disable'))
  pluginCommand
    .command('update <plugin>')
    .description('Update a plugin')
    .action(dispatchSubcommand('plugin:update'))

  const marketplaceCommand = pluginCommand
    .command('marketplace')
    .description('Manage plugin marketplaces')
  marketplaceCommand
    .command('add <source>')
    .description('Add a plugin marketplace')
    .action(dispatchSubcommand('plugin:marketplace:add'))
  marketplaceCommand
    .command('list')
    .description('List plugin marketplaces')
    .action(dispatchSubcommand('plugin:marketplace:list'))
  marketplaceCommand
    .command('remove <name>')
    .alias('rm')
    .description('Remove a plugin marketplace')
    .action(dispatchSubcommand('plugin:marketplace:remove'))
  marketplaceCommand
    .command('update [name]')
    .description('Update plugin marketplaces')
    .action(dispatchSubcommand('plugin:marketplace:update'))

  program
    .command('setup-token')
    .description('Set up a long-lived authentication token')
    .action(dispatchSubcommand('setup-token'))

  program
    .command('update')
    .alias('upgrade')
    .description('Check for updates and install if available')
    .action(dispatchSubcommand('update'))
}

export function createCliProgram(argv: string[] = process.argv) {
  const versionStr = `${getMacroVersion()} (Copilot CLI)`
  const program = new Command()
    .configureHelp(createSortedHelpConfig())
    .enablePositionalOptions()
    .name('claude')
    .description(
      'Copilot CLI - starts an interactive session by default, use -p/--print for non-interactive output',
    )
    .argument('[prompt]', 'Your prompt', String)
    .helpOption('-h, --help', 'Display help for command')
    .version(versionStr, '-v, --version', 'Output the version number')
    .option('-d, --debug [filter]', 'Enable debug mode with optional category filter', () => true)
    .addOption(
      new Option('--d2e, --debug-to-stderr', 'Write debug logs to stderr').hideHelp(),
    )
    .option('--debug-file <path>', 'Write debug logs to a specific file path', () => true)
    .option('--verbose', 'Override verbose mode setting from config', () => true)
    .option('-p, --print', 'Print response and exit (useful for pipes)', () => true)
    .option('--bare', 'Minimal mode skipping hooks, plugins, and non-essential startup', () => true)
    .addOption(new Option('--init', 'Run setup hooks for init').hideHelp())
    .addOption(
      new Option('--init-only', 'Run setup and session start hooks then exit').hideHelp(),
    )
    .addOption(
      new Option('--maintenance', 'Run setup hooks for maintenance').hideHelp(),
    )
    .addOption(
      new Option('--output-format <format>', 'Output format (only works with --print)').choices([
        'text',
        'json',
        'stream-json',
      ]),
    )
    .addOption(
      new Option('--input-format <format>', 'Input format (only works with --print)').choices([
        'text',
        'stream-json',
      ]),
    )
    .option('--json-schema <schema>', 'JSON schema for structured output validation', String)
    .option('--include-hook-events', 'Include hook events in stream-json output', () => true)
    .option(
      '--include-partial-messages',
      'Include partial message chunks as they arrive (only with --print and --output-format=stream-json)',
      () => true,
    )
    .option('--mcp-debug', '[DEPRECATED] Enable MCP debug mode', () => true)
    .option(
      '--dangerously-skip-permissions',
      'Bypass all permission checks (recommended only for sandboxes with no internet access)',
      () => true,
    )
    .option(
      '--allow-dangerously-skip-permissions',
      'Enable bypassing all permission checks as an option without enabling by default',
      () => true,
    )
    .addOption(
      new Option('--permission-mode <mode>', 'Permission mode to use for the session').choices(
        [...PERMISSION_MODES],
      ),
    )
    .addOption(
      new Option('--thinking <mode>', 'Thinking mode').choices([
        'enabled',
        'adaptive',
        'disabled',
      ]).hideHelp(),
    )
    .addOption(
      new Option('--max-thinking-tokens <tokens>', 'Max thinking tokens')
        .argParser(Number)
        .hideHelp(),
    )
    .addOption(
      new Option('--max-turns <turns>', 'Maximum agentic turns')
        .argParser(parsePositiveInteger)
        .hideHelp(),
    )
    .option(
      '--max-budget-usd <amount>',
      'Maximum dollar amount to spend on API calls (only works with --print)',
      parsePositiveNumber,
    )
    .addOption(
      new Option('--task-budget <tokens>', 'API task token budget')
        .argParser(parsePositiveInteger)
        .hideHelp(),
    )
    .option(
      '--replay-user-messages',
      'Re-emit user messages from stdin back on stdout',
      () => true,
    )
    .addOption(
      new Option('--enable-auth-status', 'Emit SDK auth status messages')
        .default(false)
        .hideHelp(),
    )
    .option('--allowedTools, --allowed-tools <tools...>', 'Comma or space-separated list of tool names to allow')
    .option('--tools <tools...>', 'Specify the list of available built-in tools')
    .option('--disallowedTools, --disallowed-tools <tools...>', 'Comma or space-separated list of tool names to deny')
    .option('--mcp-config <configs...>', 'Load MCP servers from JSON files or strings')
    .option('--strict-mcp-config', 'Only use MCP servers from --mcp-config', () => true)
    .addOption(
      new Option('--permission-prompt-tool <tool>', 'MCP tool to use for permission prompts').hideHelp(),
    )
    .option('--system-prompt <prompt>', 'System prompt to use for the session', String)
    .addOption(
      new Option('--system-prompt-file <file>', 'File containing system prompt').hideHelp(),
    )
    .option('--append-system-prompt <prompt>', 'Append a system prompt to the default system prompt', String)
    .addOption(
      new Option('--append-system-prompt-file <file>', 'File containing system prompt to append').hideHelp(),
    )
    .option('-c, --continue', 'Continue the most recent conversation in the current directory', () => true)
    .option('-r, --resume [value]', 'Resume a conversation by session ID, or open an interactive picker', (val: string) => val || true)
    .option('--fork-session', 'When resuming, create a new session ID instead of reusing the original', () => true)
    .option('--from-pr [value]', 'Resume a session linked to a PR by PR number/URL', (val: string) => val || true)
    .option('--no-session-persistence', 'Disable session persistence (only works with --print)')
    .addOption(new Option('--resume-session-at <messageId>', 'Resume up to a specific message ID').hideHelp())
    .addOption(new Option('--rewind-files <userMessageId>', 'Rewind files to a specific user message').hideHelp())
    .addOption(new Option('--prefill <text>', 'Seed early input buffer').hideHelp())
    .option('--model <model>', 'Model for the current session', String)
    .option('--effort <level>', 'Effort level for the current session (low, medium, high, max)', parseEffortLevel)
    .option('--agent <agent>', 'Agent for the current session', String)
    .option('--agents <json>', 'JSON object defining custom agents', String)
    .option('--betas <betas...>', 'Beta headers to include in API requests')
    .option('--fallback-model <model>', 'Enable automatic fallback to specified model when default is overloaded', String)
    .addOption(new Option('--workload <tag>', 'Billing-header workload tag').hideHelp())
    .option('--settings <fileOrJson>', 'Path to a settings JSON file or a JSON string to load additional settings from', String)
    .option('--setting-sources <sources>', 'Comma-separated list of setting sources to load (user, project, local)', String)
    .option('--add-dir <directories...>', 'Additional directories to allow tool access to')
    .option('--ide', 'Automatically connect to IDE on startup', () => true)
    .option('--session-id <uuid>', 'Use a specific session ID for the conversation (must be a valid UUID)', String)
    .option('-n, --name <name>', 'Set a display name for this session', String)
    .option(
      '--plugin-dir <path>',
      'Load plugins from directories for this session only (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--disable-slash-commands', 'Disable all skills', () => true)
    .option('--chrome', 'Enable Claude in Chrome integration')
    .option('--no-chrome', 'Disable Claude in Chrome integration')
    .option('--file <specs...>', 'File resources to download at startup (file_id:relative_path)')
    .option('-w, --worktree [name]', 'Create a new git worktree for this session')
    .option('--tmux', 'Create a tmux session for the worktree (requires --worktree)')
    .addOption(new Option('--sdk-url <url>', 'SDK remote WebSocket URL').hideHelp())
    .addOption(new Option('--teleport [session]', 'Resume a teleport session').hideHelp())
    .addOption(new Option('--remote [description]', 'Create a remote session').hideHelp())

  if (isFeatureEnabled('TRANSCRIPT_CLASSIFIER')) {
    program.addOption(
      new Option('--enable-auto-mode', 'Enable auto permission mode').hideHelp(),
    )
  }
  if (isFeatureEnabled('HARD_FAIL')) {
    program.addOption(
      new Option('--hard-fail', 'Exit immediately on logged errors').hideHelp(),
    )
  }

  const hasPrintFlag = argv.includes('-p') || argv.includes('--print')
  if (!hasPrintFlag) {
    registerSubcommands(program)
  }

  program.hook('preAction', async (_thisCommand, actionCommand) => {
    profileCheckpoint('preAction_start')
    await ensureMdmSettingsLoaded()
    profileCheckpoint('preAction_after_mdm')

    await init()
    profileCheckpoint('preAction_after_init')

    if (!isEnvTruthy(process.env.COPILOT_CLI_DISABLE_TERMINAL_TITLE)) {
      process.title = 'claude'
    }

    runtimeHooks.onInitSinks?.()

    const pluginDirs = actionCommand.getOptionValue('pluginDir') as
      | string[]
      | undefined
    if (pluginDirs && pluginDirs.length > 0) {
      setInlinePlugins(pluginDirs)
    }

    runSyncMigrations()
  })

  program.action(async (rawPrompt, rawOptions) => {
    const options = rawOptions as Record<string, unknown>

    if (options.bare) {
      process.env.COPILOT_CLI_SIMPLE = '1'
    }

    let prompt = typeof rawPrompt === 'string' ? rawPrompt : ''
    if (prompt === 'code') {
      process.stderr.write(
        'Warning: ignoring literal "code" positional argument.\n',
      )
      prompt = ''
    }

    if (typeof options.prefill === 'string') {
      seedEarlyInput(options.prefill)
    }

    if (typeof options.chrome === 'boolean') {
      setChromeFlagOverride(options.chrome)
    }

    const workloadTag =
      typeof options.workload === 'string' ? options.workload : undefined
    const executeAction = async (): Promise<void> => {
      if (options.tmux) {
      if (!options.worktree) {
        cliError('Error: --tmux requires --worktree.')
      }
      if (process.platform === 'win32') {
        cliError('Error: --tmux is not supported on Windows.')
      }
    }

    const sdkUrl = typeof options.sdkUrl === 'string' ? options.sdkUrl : undefined
    let inputFormat =
      typeof options.inputFormat === 'string' ? options.inputFormat : undefined
    let outputFormat =
      typeof options.outputFormat === 'string'
        ? options.outputFormat
        : undefined
    let isPrint = Boolean(options.print)

    if (sdkUrl) {
      inputFormat = 'stream-json'
      outputFormat = 'stream-json'
      isPrint = true
    }

    if (
      options.sessionId &&
      (options.continue || options.resume) &&
      !options.forkSession
    ) {
      cliError(
        'Error: --session-id cannot be used with --continue or --resume unless --fork-session is also specified.',
      )
    }

    let validatedSessionId: string | undefined
    if (typeof options.sessionId === 'string') {
      if (sdkUrl) {
        validatedSessionId = options.sessionId
      } else {
        const parsedUuid = validateUuid(options.sessionId)
        if (!parsedUuid) {
          cliError('Error: Invalid session ID. Must be a valid UUID.')
        }
        validatedSessionId = parsedUuid
      }
    }

    if (
      options.fallbackModel &&
      options.model &&
      options.fallbackModel === options.model
    ) {
      cliError(
        'Error: --fallback-model cannot be the same as --model.',
      )
    }

    if (options.systemPrompt && options.systemPromptFile) {
      cliError(
        'Error: --system-prompt and --system-prompt-file are mutually exclusive.',
      )
    }
    if (typeof options.systemPromptFile === 'string') {
      try {
        options.systemPrompt = getFsImplementation().readFileSync(
          options.systemPromptFile,
          { encoding: 'utf-8' },
        )
      } catch (error) {
        cliError(
          `Error: Failed to read --system-prompt-file: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    if (options.appendSystemPrompt && options.appendSystemPromptFile) {
      cliError(
        'Error: --append-system-prompt and --append-system-prompt-file are mutually exclusive.',
      )
    }
    if (typeof options.appendSystemPromptFile === 'string') {
      try {
        options.appendSystemPrompt = getFsImplementation().readFileSync(
          options.appendSystemPromptFile,
          { encoding: 'utf-8' },
        )
      } catch (error) {
        cliError(
          `Error: Failed to read --append-system-prompt-file: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    if (inputFormat === 'stream-json' && outputFormat !== 'stream-json') {
      cliError(
        'Error: --input-format=stream-json requires --output-format=stream-json.',
      )
    }

    if (
      options.replayUserMessages &&
      (inputFormat !== 'stream-json' || outputFormat !== 'stream-json')
    ) {
      cliError(
        'Error: --replay-user-messages requires both --input-format=stream-json and --output-format=stream-json.',
      )
    }

    const isInitOnly = Boolean(options.initOnly)
    const isNonInteractive =
      isPrint || isInitOnly || Boolean(sdkUrl) || !process.stdout.isTTY

    if (
      options.includePartialMessages &&
      (!isNonInteractive || outputFormat !== 'stream-json')
    ) {
      cliError(
        'Error: --include-partial-messages requires --print and --output-format=stream-json.',
      )
    }

    if (options.sessionPersistence === false && !isNonInteractive) {
      cliError(
        'Error: --no-session-persistence can only be used with --print.',
      )
    }

    const permissionMode: PermissionMode = options.dangerouslySkipPermissions
      ? 'bypassPermissions'
      : ((options.permissionMode as PermissionMode | undefined) ?? 'default')

    setSessionBypassPermissionsMode(permissionMode === 'bypassPermissions')

    const worktreeOption = options.worktree
    const worktreeEnabled = Boolean(worktreeOption)
    const worktreeName =
      typeof worktreeOption === 'string' ? worktreeOption : undefined

    await setup(
      getCwd(),
      permissionMode,
      Boolean(options.allowDangerouslySkipPermissions),
      worktreeEnabled,
      worktreeName,
      Boolean(options.tmux),
      validatedSessionId,
    )

    if (isInitOnly) {
      applyConfigEnvironmentVariables()
      await runtimeHooks.onSetupAndSessionStartHooks?.()
      await gracefulShutdown(0)
      return
    }

    if (!prompt && !process.stdin.isTTY && isNonInteractive) {
      prompt = await readPipedStdin(inputFormat ?? 'text')
    }

    if (isNonInteractive) {
      if (outputFormat === 'json' || outputFormat === 'stream-json') {
        setHasFormattedOutput(true)
      }
      applyConfigEnvironmentVariables()
      initializeTelemetryAfterTrust()
      if (options.sessionPersistence === false) {
        setSessionPersistenceDisabled(true)
      }
      if (runtimeHooks.onHeadlessRun) {
        await runtimeHooks.onHeadlessRun(prompt, options)
        return
      }
      gracefulShutdownSync(0)
      return
    }

    if (runtimeHooks.onInteractiveRun) {
      await runtimeHooks.onInteractiveRun(prompt, options)
      return
    }

    process.stdout.write(
      `Copilot CLI ${getMacroVersion()} bootstrap ready (interactive REPL wired in Phase 5/6).\n`,
    )
    await gracefulShutdown(0)
    }

    if (workloadTag) {
      await runWithWorkload(workloadTag, executeAction)
    } else {
      await executeAction()
    }
  })

  return program
}

export async function main(argv: string[] = process.argv): Promise<void> {
  profileCheckpoint('main_function_start')
  process.env.NoDefaultCurrentDirectoryInExePath = '1'
  initializeWarningHandler()

  process.on('exit', resetCursor)
  process.on('SIGINT', () => {
    if (argv.includes('-p') || argv.includes('--print')) {
      return
    }
    process.exit(0)
  })
  profileCheckpoint('main_warning_handler_initialized')

  const cliArgs = argv.slice(2)
  const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print')
  const hasInitOnlyFlag = cliArgs.includes('--init-only')
  const hasSdkUrl = cliArgs.some(arg => arg.startsWith('--sdk-url'))
  const isNonInteractive =
    hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY

  if (isNonInteractive) {
    stopCapturingEarlyInput()
  }

  setIsInteractive(!isNonInteractive)
  initializeEntrypoint(isNonInteractive)
  determineClientType(isNonInteractive)
  profileCheckpoint('main_client_type_determined')

  eagerLoadSettings(argv)
  profileCheckpoint('main_before_run')

  const program = createCliProgram(argv)
  await program.parseAsync(argv)

  profileCheckpoint('main_after_run')
  profileReport()
}
