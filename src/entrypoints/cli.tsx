#!/usr/bin/env bun

import { ensureMacroGlobals, isFeatureEnabled } from '../utilities/feature_flags.js'

process.env.COREPACK_ENABLE_AUTO_PIN = '0'

if (process.env.COPILOT_CLI_REMOTE === 'true') {
  const existingNodeOptions = process.env.NODE_OPTIONS ?? ''
  if (!existingNodeOptions.includes('--max-old-space-size=')) {
    process.env.NODE_OPTIONS = existingNodeOptions
      ? `${existingNodeOptions} --max-old-space-size=8192`
      : '--max-old-space-size=8192'
  }
}

if (
  isFeatureEnabled('ABLATION_BASELINE') &&
  process.env.COPILOT_CLI_ABLATION_BASELINE
) {
  process.env.COPILOT_CLI_SIMPLE ??= '1'
  process.env.COPILOT_CLI_DISABLE_THINKING ??= '1'
  process.env.DISABLE_INTERLEAVED_THINKING ??= '1'
  process.env.DISABLE_COMPACT ??= '1'
  process.env.DISABLE_AUTO_COMPACT ??= '1'
  process.env.COPILOT_CLI_DISABLE_AUTO_MEMORY ??= '1'
  process.env.COPILOT_CLI_DISABLE_BACKGROUND_TASKS ??= '1'
}

ensureMacroGlobals()

async function runCli(): Promise<void> {
  const args = process.argv.slice(2)

  // Fast-path: zero heavy imports for --version / -v / -V
  if (
    args.length === 1 &&
    (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')
  ) {
    console.log(`${MACRO.VERSION} (Copilot CLI)`)
    return
  }

  const { profileCheckpoint } = await import('../utilities/startup_profiler.js')
  profileCheckpoint('cli_entry')

  // Redirect --update / --upgrade to the `update` subcommand
  if (
    args.length === 1 &&
    (args[0] === '--update' || args[0] === '--upgrade')
  ) {
    process.argv = [process.argv[0]!, process.argv[1]!, 'update']
  }

  // Apply --bare before main.tsx module evaluation
  if (args.includes('--bare')) {
    process.env.COPILOT_CLI_SIMPLE = '1'
  }

  const { startCapturingEarlyInput } = await import('../utilities/early_input.js')
  startCapturingEarlyInput()

  profileCheckpoint('cli_before_main_import')
  const { main: cliMain } = await import('../main.js')
  profileCheckpoint('cli_after_main_import')

  await cliMain()
  profileCheckpoint('cli_after_main_complete')
}

void runCli()
