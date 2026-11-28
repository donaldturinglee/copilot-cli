/**
 * 4-tab interactive `/plugin` management TUI (Discover, Installed, Marketplaces,
 * Errors, plus inline Validate & Marketplace addition).
 */

import React, { useMemo, useState } from 'react'
import { Select } from '../../components/custom_select/select.js'
import { Dialog } from '../../components/design_system/dialog.js'
import { ThemedText } from '../../components/design_system/themed_text.js'
import { TextInput } from '../../components/text_input.js'
import { FIGURES } from '../../constants/figures.js'
import { Box } from '../../ink/components/box.js'
import { useInput } from '../../ink/hooks/use_input.js'
import {
  disablePluginOp,
  enablePluginOp,
  installPluginOp,
  uninstallPluginOp,
} from '../../services/plugins/plugin_operations.js'
import { useAppState, useSetAppState } from '../../state/app_state.js'
import { getPluginErrorMessage } from '../../types/plugin.js'
import {
  addMarketplace,
  listAllMarketplaces,
  removeMarketplace,
  updateMarketplaces,
} from '../../utilities/plugins/marketplace_manager.js'
import { parseMarketplaceInput } from '../../utilities/plugins/parse_marketplace_input.js'
import { refreshActivePlugins } from '../../utilities/plugins/refresh.js'
import { validateManifest } from '../../utilities/plugins/validate_plugin.js'
import { parsePluginArgs } from './parse_args.js'
import type { PluginSettingsProps } from './types.js'

type TabName = 'Discover' | 'Installed' | 'Marketplaces' | 'Errors'
const TABS: readonly TabName[] = [
  'Discover',
  'Installed',
  'Marketplaces',
  'Errors',
]

/**
 * Interactive `/plugin` settings dialog with Tab navigation across Discover,
 * Installed, Marketplaces, and Errors.
 */
export function PluginSettings({
  onComplete,
  args,
}: PluginSettingsProps): React.ReactNode {
  const initialView = useMemo(() => parsePluginArgs(args), [args])
  const pluginsState = useAppState(s => s.plugins)
  const setAppState = useSetAppState()

  const initialTab: TabName =
    initialView.type === 'manage-plugins'
      ? 'Installed'
      : initialView.type === 'manage-marketplaces' ||
          initialView.type === 'add-marketplace'
        ? 'Marketplaces'
        : 'Discover'

  const [activeTab, setActiveTab] = useState<TabName>(initialTab)
  const [addingMarketplace, setAddingMarketplace] = useState(
    initialView.type === 'add-marketplace',
  )
  const [marketplaceInput, setMarketplaceInput] = useState(
    initialView.type === 'add-marketplace'
      ? (initialView.initialValue ?? '')
      : '',
  )
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  useInput((_ch, key) => {
    if (addingMarketplace) {
      if (key.escape) {
        setAddingMarketplace(false)
      }
      return
    }
    if (key.tab) {
      const idx = TABS.indexOf(activeTab)
      const nextIdx = key.shift
        ? (idx - 1 + TABS.length) % TABS.length
        : (idx + 1) % TABS.length
      setActiveTab(TABS[nextIdx]!)
    }
  })

  if (initialView.type === 'validate' && initialView.path) {
    const report = validateManifest(initialView.path)
    return (
      <Dialog
        title="Validate Plugin Manifest"
        subtitle={report.path}
        onCancel={() => onComplete()}
      >
        <Box flexDirection="column" gap={1}>
          {report.valid ? (
            <ThemedText color="success">
              {FIGURES.tick} Valid {report.kind}{' '}
              {report.name ? `"${report.name}"` : ''}
            </ThemedText>
          ) : (
            report.errors.map((err, i) => (
              <ThemedText key={i} color="error">
                {FIGURES.cross} {err}
              </ThemedText>
            ))
          )}
        </Box>
      </Dialog>
    )
  }

  const marketplaces = listAllMarketplaces()
  const availablePlugins = marketplaces.flatMap(mp =>
    (mp.manifest?.plugins ?? []).map(entry => ({
      id: `${entry.name}@${mp.name}`,
      name: entry.name,
      marketplace: mp.name,
      description: entry.description ?? '',
    })),
  )

  const installedItems = [
    ...pluginsState.enabled.map(p => ({ plugin: p, enabled: true })),
    ...pluginsState.disabled.map(p => ({ plugin: p, enabled: false })),
  ]

  const tabBar = TABS.map(tab =>
    tab === activeTab ? `[${tab}]` : ` ${tab} `,
  ).join(' · ')

  return (
    <Dialog
      title="Plugins & Marketplaces"
      subtitle={`${tabBar} (Tab to switch)`}
      onCancel={() => onComplete(statusMessage ?? undefined)}
    >
      <Box flexDirection="column" gap={1}>
        {statusMessage ? (
          <ThemedText color="suggestion">{statusMessage}</ThemedText>
        ) : null}

        {activeTab === 'Discover' ? (
          availablePlugins.length === 0 ? (
            <ThemedText dimColor>
              No marketplace plugins available yet. Switch to Marketplaces (Tab)
              to add a marketplace.
            </ThemedText>
          ) : (
            <Select
              options={availablePlugins.map(item => ({
                label: `${item.id}${item.description ? ` — ${item.description}` : ''}`,
                value: item.id,
              }))}
              onChange={selectedId => {
                void installPluginOp(selectedId, 'user')
                  .then(() => refreshActivePlugins(setAppState))
                  .then(() => {
                    onComplete(`Installed and activated plugin ${selectedId}.`)
                  })
                  .catch(err => {
                    setStatusMessage(
                      `Install failed: ${err instanceof Error ? err.message : String(err)}`,
                    )
                  })
              }}
              onCancel={() => onComplete()}
            />
          )
        ) : null}

        {activeTab === 'Installed' ? (
          installedItems.length === 0 ? (
            <ThemedText dimColor>No plugins installed.</ThemedText>
          ) : (
            <Select
              options={installedItems.map(({ plugin, enabled }) => ({
                label: `${enabled ? FIGURES.tick : '○'} ${plugin.source} (${enabled ? 'disable' : 'enable'} / uninstall)`,
                value: `${enabled ? 'disable' : 'enable'}:${plugin.source}`,
              }))}
              onChange={choice => {
                const sep = choice.indexOf(':')
                const action = choice.slice(0, sep)
                const targetId = choice.slice(sep + 1)
                const op =
                  action === 'enable'
                    ? enablePluginOp(targetId).then(() => 'Enabled')
                    : action === 'disable'
                      ? disablePluginOp({ rawSpec: targetId }).then(
                          () => 'Disabled',
                        )
                      : uninstallPluginOp(targetId).then(() => 'Uninstalled')
                void op
                  .then(verb =>
                    refreshActivePlugins(setAppState).then(() => verb),
                  )
                  .then(verb => {
                    onComplete(`${verb} plugin ${targetId}.`)
                  })
                  .catch(err => {
                    setStatusMessage(
                      err instanceof Error ? err.message : String(err),
                    )
                  })
              }}
              onCancel={() => onComplete()}
            />
          )
        ) : null}

        {activeTab === 'Marketplaces' ? (
          addingMarketplace ? (
            <Box flexDirection="column" gap={1}>
              <ThemedText bold>
                Enter marketplace source (directory, URL, or GitHub owner/repo):
              </ThemedText>
              <TextInput
                value={marketplaceInput}
                onChange={setMarketplaceInput}
                onSubmit={raw => {
                  try {
                    const parsed = parseMarketplaceInput(raw)
                    void addMarketplace(parsed)
                      .then(added => {
                        setAddingMarketplace(false)
                        setMarketplaceInput('')
                        setStatusMessage(
                          `Added marketplace "${added.name}" (${added.manifest.plugins.length} plugin(s)).`,
                        )
                      })
                      .catch(err => {
                        setStatusMessage(
                          err instanceof Error ? err.message : String(err),
                        )
                      })
                  } catch (err) {
                    setStatusMessage(
                      err instanceof Error ? err.message : String(err),
                    )
                  }
                }}
              />
            </Box>
          ) : (
            <Select
              options={[
                { label: '+ Add marketplace…', value: '__add__' },
                { label: '↻ Update all marketplaces', value: '__update_all__' },
                ...marketplaces.map(mp => ({
                  label: `Remove ${mp.name} (${mp.manifest?.plugins.length ?? 0} plugins)`,
                  value: `rm:${mp.name}`,
                })),
              ]}
              onChange={choice => {
                if (choice === '__add__') {
                  setAddingMarketplace(true)
                } else if (choice === '__update_all__') {
                  void updateMarketplaces()
                    .then(updated => {
                      setStatusMessage(
                        `Updated ${updated.length} marketplace(s).`,
                      )
                    })
                    .catch(err => {
                      setStatusMessage(
                        err instanceof Error ? err.message : String(err),
                      )
                    })
                } else if (choice.startsWith('rm:')) {
                  const mpName = choice.slice(3)
                  removeMarketplace(mpName)
                  setStatusMessage(`Removed marketplace "${mpName}".`)
                }
              }}
              onCancel={() => onComplete()}
            />
          )
        ) : null}

        {activeTab === 'Errors' ? (
          pluginsState.errors.length === 0 ? (
            <ThemedText color="success">
              {FIGURES.tick} No plugin errors.
            </ThemedText>
          ) : (
            <Box flexDirection="column">
              {pluginsState.errors.map((err, idx) => (
                <ThemedText key={idx} color="error">
                  {FIGURES.cross} [{err.source}] {getPluginErrorMessage(err)}
                </ThemedText>
              ))}
            </Box>
          )
        ) : null}
      </Box>
    </Dialog>
  )
}
