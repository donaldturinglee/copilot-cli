/**
 * CLI subcommand handlers for `copilot plugin ...` and `copilot plugin marketplace ...`.
 */

import { FIGURES } from '../../constants/figures.js'
import {
  disablePluginOp,
  enablePluginOp,
  installPluginOp,
  uninstallPluginOp,
  updatePluginOp,
  type MutablePluginScope,
} from '../../services/plugins/plugin_operations.js'
import {
  addMarketplace,
  listAllMarketplaces,
  removeMarketplace,
  updateMarketplaces,
} from '../../utilities/plugins/marketplace_manager.js'
import { parseMarketplaceInput } from '../../utilities/plugins/parse_marketplace_input.js'
import { loadAllPluginsCacheOnly } from '../../utilities/plugins/plugin_loader.js'
import { validateManifest } from '../../utilities/plugins/validate_plugin.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utilities/settings/settings.js'

function parseScopeOption(raw?: string): MutablePluginScope | undefined {
  if (!raw) return undefined
  const lower = raw.toLowerCase()
  if (lower === 'user' || lower === 'project' || lower === 'local') {
    return lower
  }
  throw new Error(
    `Invalid --scope "${raw}". Valid scopes: user, project, local.`,
  )
}

/**
 * Handles `copilot plugin validate <path>`.
 */
export async function pluginValidateHandler(targetPath: string): Promise<void> {
  const report = validateManifest(targetPath)
  for (const warn of report.warnings) {
    process.stdout.write(`${FIGURES.warning} Warning: ${warn}\n`)
  }
  if (!report.valid) {
    for (const err of report.errors) {
      process.stderr.write(`${FIGURES.cross} Error: ${err}\n`)
    }
    process.exitCode = 1
    return
  }
  process.stdout.write(
    `${FIGURES.tick} Valid ${report.kind} manifest${report.name ? ` "${report.name}"` : ''} (${report.path})\n`,
  )
}

/**
 * Handles `copilot plugin list [--json] [--available]`.
 */
export async function pluginListHandler(options?: {
  json?: boolean
  available?: boolean
}): Promise<void> {
  const loaded = await loadAllPluginsCacheOnly()
  const installed = [
    ...loaded.enabled.map(p => ({
      id: p.source,
      name: p.name,
      version: p.manifest.version,
      repository: p.repository,
      enabled: true,
    })),
    ...loaded.disabled.map(p => ({
      id: p.source,
      name: p.name,
      version: p.manifest.version,
      repository: p.repository,
      enabled: false,
    })),
  ]

  if (options?.json) {
    if (options.available) {
      const available = listAllMarketplaces().flatMap(mp =>
        (mp.manifest?.plugins ?? []).map(entry => ({
          id: `${entry.name}@${mp.name}`,
          name: entry.name,
          marketplace: mp.name,
          description: entry.description,
          version: entry.version,
        })),
      )
      process.stdout.write(
        `${JSON.stringify({ installed, available }, null, 2)}\n`,
      )
      return
    }
    process.stdout.write(`${JSON.stringify(installed, null, 2)}\n`)
    return
  }

  if (installed.length === 0) {
    process.stdout.write('No plugins installed.\n')
    return
  }

  for (const item of installed) {
    const icon = item.enabled ? FIGURES.tick : '○'
    process.stdout.write(
      `${icon} ${item.id}${item.version ? ` (v${item.version})` : ''} — ${item.enabled ? 'enabled' : 'disabled'}\n`,
    )
  }
}

/**
 * Handles `copilot plugin install <plugin> [-s, --scope <scope>]`.
 */
export async function pluginInstallHandler(
  pluginSpec: string,
  options?: { scope?: string },
): Promise<void> {
  const scope = parseScopeOption(options?.scope) ?? 'user'
  const res = await installPluginOp(pluginSpec, scope)
  process.stdout.write(
    `${FIGURES.tick} Installed ${res.pluginId} (v${res.version}) in ${scope} scope${res.installedClosure.length > 1 ? ` (${res.installedClosure.length} packages total)` : ''}.\n`,
  )
}

/**
 * Handles `copilot plugin uninstall <plugin> [-s, --scope <scope>] [--keep-data]`.
 */
export async function pluginUninstallHandler(
  pluginSpec: string,
  options?: { scope?: string; keepData?: boolean },
): Promise<void> {
  const scope = parseScopeOption(options?.scope)
  const res = await uninstallPluginOp(pluginSpec, {
    scope,
    keepData: options?.keepData,
  })
  for (const warn of res.warnings) {
    process.stderr.write(`${warn}\n`)
  }
  process.stdout.write(`${FIGURES.tick} Uninstalled ${res.pluginId}.\n`)
}

/**
 * Handles `copilot plugin enable <plugin> [-s, --scope <scope>]`.
 */
export async function pluginEnableHandler(
  pluginSpec: string,
  options?: { scope?: string },
): Promise<void> {
  const scope = parseScopeOption(options?.scope)
  const res = await enablePluginOp(pluginSpec, scope)
  process.stdout.write(
    `${FIGURES.tick} Enabled ${res.pluginId} (${res.scope} scope).\n`,
  )
}

/**
 * Handles `copilot plugin disable [plugin] [-a, --all] [-s, --scope <scope>]`.
 */
export async function pluginDisableHandler(
  pluginSpec?: string,
  options?: { scope?: string; all?: boolean },
): Promise<void> {
  const scope = parseScopeOption(options?.scope)
  const res = await disablePluginOp({
    rawSpec: pluginSpec,
    scope,
    disableAll: options?.all,
  })
  for (const warn of res.warnings) {
    process.stderr.write(`${warn}\n`)
  }
  process.stdout.write(
    `${FIGURES.tick} Disabled ${res.disabledIds.length} plugin(s).\n`,
  )
}

/**
 * Handles `copilot plugin update <plugin> [-s, --scope <scope>]`.
 */
export async function pluginUpdateHandler(
  pluginSpec: string,
  options?: { scope?: string },
): Promise<void> {
  const scope = parseScopeOption(options?.scope) ?? 'user'
  const res = await updatePluginOp(pluginSpec, scope)
  process.stdout.write(
    `${FIGURES.tick} Updated ${res.pluginId} to v${res.version}.\n`,
  )
}

/**
 * Handles `copilot plugin marketplace add <source> [--sparse <paths...>] [--scope <scope>]`.
 */
export async function marketplaceAddHandler(
  rawSource: string,
  options?: { sparse?: string[]; scope?: string },
): Promise<void> {
  const scope = parseScopeOption(options?.scope) ?? 'user'
  const source = parseMarketplaceInput(rawSource, options?.sparse)
  const added = await addMarketplace(source)

  if (scope === 'project' || scope === 'local') {
    const settingSource =
      scope === 'project' ? 'projectSettings' : 'localSettings'
    const prev =
      getSettingsForSource(settingSource)?.extraKnownMarketplaces ?? {}
    updateSettingsForSource(settingSource, {
      extraKnownMarketplaces: {
        ...prev,
        [added.name]: {
          source: source as unknown as { source: string },
        },
      },
    })
  }

  process.stdout.write(
    `${FIGURES.tick} Added marketplace "${added.name}" (${added.manifest.plugins.length} plugin(s)).\n`,
  )
}

/**
 * Handles `copilot plugin marketplace list [--json]`.
 */
export async function marketplaceListHandler(options?: {
  json?: boolean
}): Promise<void> {
  const list = listAllMarketplaces()
  if (options?.json) {
    process.stdout.write(
      `${JSON.stringify(
        list.map(m => ({
          name: m.name,
          source: m.record.source,
          installLocation: m.record.installLocation,
          lastUpdated: m.record.lastUpdated,
          pluginCount: m.manifest?.plugins.length ?? 0,
        })),
        null,
        2,
      )}\n`,
    )
    return
  }

  if (list.length === 0) {
    process.stdout.write('No plugin marketplaces configured.\n')
    return
  }

  for (const m of list) {
    process.stdout.write(
      `${m.name} (${m.record.source.source}) — ${m.manifest?.plugins.length ?? 0} plugin(s)\n`,
    )
  }
}

/**
 * Handles `copilot plugin marketplace remove <name>`.
 */
export async function marketplaceRemoveHandler(name: string): Promise<void> {
  const removed = removeMarketplace(name)
  if (!removed) {
    throw new Error(`Marketplace "${name}" is not registered.`)
  }
  process.stdout.write(`${FIGURES.tick} Removed marketplace "${name}".\n`)
}

/**
 * Handles `copilot plugin marketplace update [name]`.
 */
export async function marketplaceUpdateHandler(name?: string): Promise<void> {
  const updated = await updateMarketplaces(name)
  process.stdout.write(
    `${FIGURES.tick} Updated ${updated.length} marketplace(s)${updated.length > 0 ? `: ${updated.join(', ')}` : ''}.\n`,
  )
}
