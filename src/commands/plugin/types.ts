/**
 * Reconstructed UI types for `src/commands/plugin/*`.
 */

export interface PluginSettingsProps {
  onComplete: (result?: string) => void
  args?: string
  showMcpRedirectMessage?: boolean
}

export type ViewState =
  | { type: 'menu' }
  | { type: 'help' }
  | { type: 'validate'; path?: string }
  | { type: 'discover-plugins'; targetPlugin?: string }
  | {
      type: 'browse-marketplace'
      targetMarketplace?: string
      targetPlugin?: string
    }
  | {
      type: 'manage-plugins'
      targetPlugin?: string
      targetMarketplace?: string
      action?: 'enable' | 'disable' | 'uninstall'
    }
  | {
      type: 'manage-marketplaces'
      targetMarketplace?: string
      action?: 'update' | 'remove'
    }
  | { type: 'marketplace-menu' }
  | { type: 'marketplace-list' }
  | { type: 'add-marketplace'; initialValue?: string }
