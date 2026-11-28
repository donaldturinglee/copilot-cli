/**
 * CLI subcommands for Cross-App Access (`copilot mcp xaa setup|login|show|clear`).
 * Uses lazy dynamic imports inside action handlers so `main.tsx` startup (`--help`,
 * `--version`, `--init-only`) never eagerly loads `@modelcontextprotocol/sdk`.
 */

import type { Command } from '@commander-js/extra-typings'
import { isEnvTruthy } from '../../utilities/env_utils.js'

/**
 * Registers `mcp xaa {setup,login,show,clear}` when `COPILOT_CLI_ENABLE_XAA` or
 * `CLAUDE_CODE_ENABLE_XAA` is enabled.
 */
export function registerMcpXaaIdpCommand(mcpCommand: Command): void {
  if (
    !isEnvTruthy(process.env.COPILOT_CLI_ENABLE_XAA) &&
    !isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_XAA)
  ) {
    return
  }

  const xaa = mcpCommand
    .command('xaa')
    .description('Manage Cross-App Access (XAA) Identity Provider credentials')

  xaa
    .command('setup <issuer> <clientId>')
    .description('Configure XAA OIDC Identity Provider')
    .option('--client-secret <secret>', 'Confidential OIDC client secret')
    .option('--callback-port <port>', 'Loopback OAuth callback port')
    .action(async (issuer, clientId, opts) => {
      const [{ saveIdpClientSecret }, { updateSettingsForSource }] =
        await Promise.all([
          import('../../services/mcp/xaa_idp_login.js'),
          import('../../utilities/settings/settings.js'),
        ])
      const callbackPort = opts.callbackPort
        ? Number(opts.callbackPort)
        : undefined
      updateSettingsForSource('userSettings', {
        xaaIdp: {
          issuer,
          clientId,
          ...(callbackPort && Number.isInteger(callbackPort)
            ? { callbackPort }
            : {}),
        },
      })
      if (opts.clientSecret) {
        saveIdpClientSecret(issuer, opts.clientSecret)
      }
      process.stdout.write(`Configured XAA Identity Provider: ${issuer}\n`)
    })

  xaa
    .command('login')
    .description('Authenticate with the configured XAA Identity Provider')
    .action(async () => {
      const { acquireIdpIdToken, getXaaIdpSettings } = await import(
        '../../services/mcp/xaa_idp_login.js'
      )
      const idp = getXaaIdpSettings()
      if (!idp) {
        process.stderr.write(
          'No XAA IdP configured. Run "copilot mcp xaa setup <issuer> <clientId>" first.\n',
        )
        process.exitCode = 1
        return
      }
      await acquireIdpIdToken({
        idp,
        onAuthorizationUrl: url => {
          process.stdout.write(`Opening browser for IdP login: ${url}\n`)
        },
      })
      process.stdout.write(`Authenticated with XAA IdP ${idp.issuer}.\n`)
    })

  xaa
    .command('show')
    .description('Show XAA IdP configuration and cached id_token status')
    .action(async () => {
      const { getCachedIdpIdTokenStatus, getXaaIdpSettings } = await import(
        '../../services/mcp/xaa_idp_login.js'
      )
      const idp = getXaaIdpSettings()
      if (!idp) {
        process.stdout.write('No XAA Identity Provider configured.\n')
        return
      }
      const status = getCachedIdpIdTokenStatus(idp.issuer)
      process.stdout.write(
        `Issuer: ${idp.issuer}\nClient ID: ${idp.clientId}\nCached id_token: ${status.present ? (status.expired ? 'expired' : 'valid') : 'none'}\n`,
      )
    })

  xaa
    .command('clear')
    .description('Clear cached XAA IdP id_token and client secret')
    .action(async () => {
      const { clearIdpClientSecret, clearIdpIdToken, getXaaIdpSettings } =
        await import('../../services/mcp/xaa_idp_login.js')
      const idp = getXaaIdpSettings()
      if (idp) {
        clearIdpIdToken(idp.issuer)
        clearIdpClientSecret(idp.issuer)
      }
      process.stdout.write('Cleared XAA IdP credentials.\n')
    })
}
