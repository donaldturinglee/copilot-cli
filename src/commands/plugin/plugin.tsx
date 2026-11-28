/**
 * `/plugin` (`/plugins`, `/marketplace`) local-jsx command implementation.
 */

import React from 'react'
import type {
  LocalJsxCommandContext,
  LocalJsxCommandOnDone,
} from '../../types/command.js'
import { PluginSettings } from './plugin_settings.js'

/**
 * Mounts `<PluginSettings />` with optional slash command sub-arguments.
 */
export async function call(
  onDone: LocalJsxCommandOnDone,
  _context: LocalJsxCommandContext,
  args: string,
): Promise<React.ReactNode> {
  return <PluginSettings onComplete={res => onDone(res)} args={args} />
}
