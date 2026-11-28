/**
 * Zod v4 schemas for `plugin.json`, `marketplace.json`, `installed_plugins.json` (v2),
 * `known_marketplaces.json`, `.lsp.json`, and plugin `hooks.json`.
 */

import { z } from 'zod/v4'
import { HooksSchema } from '../../schemas/hooks.js'
import { McpServerConfigSchema } from '../../services/mcp/types.js'
import { lazySchema } from '../lazy_schema.js'
import { isBlockedOfficialName } from './official_marketplace.js'

const RelativePathSchema = lazySchema(() =>
  z.string().min(3).startsWith('./', 'Path must start with "./"'),
)

const RelativeJsonPathSchema = lazySchema(() =>
  RelativePathSchema().refine(p => p.toLowerCase().endsWith('.json'), {
    message: 'Path must end with .json',
  }),
)

const RelativeMarkdownPathSchema = lazySchema(() =>
  RelativePathSchema().refine(p => p.toLowerCase().endsWith('.md'), {
    message: 'Path must end with .md',
  }),
)

const McpbSourcePathSchema = lazySchema(() =>
  z
    .union([RelativePathSchema(), z.string().url()])
    .refine(
      s => {
        const lower = s.toLowerCase()
        return lower.endsWith('.mcpb') || lower.endsWith('.dxt')
      },
      { message: 'MCPB bundle source must end with .mcpb or .dxt' },
    ),
)

export const PluginAuthorSchema = lazySchema(() =>
  z.object({
    name: z.string().min(1),
    email: z.string().optional(),
    url: z.string().optional(),
  }),
)

export const DependencyRefSchema = lazySchema(() =>
  z.union([
    z
      .string()
      .regex(
        /^[a-z0-9][-a-z0-9._]*(@[a-z0-9][-a-z0-9._]*)?(@\^[^@]*)?$/i,
        'Invalid plugin dependency identifier',
      )
      .transform(s => s.replace(/@\^[^@]*$/, '')),
    z
      .looseObject({
        name: z.string().regex(/^[a-z0-9][-a-z0-9._]*$/i),
        marketplace: z
          .string()
          .regex(/^[a-z0-9][-a-z0-9._]*$/i)
          .optional(),
      })
      .transform(obj =>
        obj.marketplace ? `${obj.name}@${obj.marketplace}` : obj.name,
      ),
  ]),
)

export const CommandMetadataSchema = lazySchema(() =>
  z
    .object({
      source: RelativePathSchema().optional(),
      content: z.string().optional(),
      description: z.string().optional(),
      argumentHint: z.string().optional(),
      model: z.string().optional(),
      allowedTools: z.array(z.string()).optional(),
    })
    .refine(
      data => Boolean(data.source) !== Boolean(data.content),
      'Specify either "source" or "content" in command metadata, not both',
    ),
)

export const PluginUserConfigOptionSchema = lazySchema(() =>
  z.strictObject({
    type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
    title: z.string(),
    description: z.string(),
    required: z.boolean().optional(),
    default: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
      .optional(),
    multiple: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
)

export type PluginUserConfigOption = z.infer<
  ReturnType<typeof PluginUserConfigOptionSchema>
>

export const ChannelDeclarationSchema = lazySchema(() =>
  z.strictObject({
    server: z.string().min(1),
    displayName: z.string().optional(),
    userConfig: z
      .record(
        z.string().regex(/^[A-Za-z_]\w*$/),
        PluginUserConfigOptionSchema(),
      )
      .optional(),
  }),
)

export const LspServerConfigSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .min(1)
      .refine(
        cmd => !(cmd.includes(' ') && !cmd.startsWith('/')),
        'Command should not contain spaces. Use args array for arguments.',
      ),
    args: z.array(z.string().min(1)).optional(),
    extensionToLanguage: z
      .record(
        z
          .string()
          .min(2)
          .refine(
            ext => ext.startsWith('.'),
            'File extensions must start with dot (e.g. ".ts")',
          ),
        z.string().min(1),
      )
      .refine(
        rec => Object.keys(rec).length > 0,
        'extensionToLanguage must define at least one mapping',
      ),
    transport: z.enum(['stdio', 'socket']).default('stdio'),
    env: z.record(z.string(), z.string()).optional(),
    initializationOptions: z.unknown().optional(),
    settings: z.unknown().optional(),
    workspaceFolder: z.string().optional(),
    startupTimeout: z.number().int().positive().optional(),
    shutdownTimeout: z.number().int().positive().optional(),
    restartOnCrash: z.boolean().optional(),
    maxRestarts: z.number().int().nonnegative().optional(),
  }),
)

export const PluginHooksSchema = lazySchema(() =>
  z.object({
    description: z.string().optional(),
    hooks: HooksSchema(),
  }),
)

export const PluginManifestSchema = lazySchema(() =>
  z.object({
    name: z
      .string()
      .min(1)
      .refine(s => !s.includes(' '), 'Plugin name cannot contain spaces'),
    version: z.string().optional(),
    description: z.string().optional(),
    author: PluginAuthorSchema().optional(),
    homepage: z.string().url().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    dependencies: z.array(DependencyRefSchema()).optional(),
    hooks: z
      .union([
        RelativeJsonPathSchema(),
        HooksSchema(),
        z.array(z.union([RelativeJsonPathSchema(), HooksSchema()])),
      ])
      .optional(),
    commands: z
      .union([
        RelativePathSchema(),
        z.array(RelativePathSchema()),
        z.record(z.string(), CommandMetadataSchema()),
      ])
      .optional(),
    agents: z
      .union([RelativeMarkdownPathSchema(), z.array(RelativeMarkdownPathSchema())])
      .optional(),
    skills: z
      .union([RelativePathSchema(), z.array(RelativePathSchema())])
      .optional(),
    outputStyles: z
      .union([RelativePathSchema(), z.array(RelativePathSchema())])
      .optional(),
    channels: z.array(ChannelDeclarationSchema()).optional(),
    mcpServers: z
      .union([
        RelativeJsonPathSchema(),
        McpbSourcePathSchema(),
        z.record(z.string(), McpServerConfigSchema()),
        z.array(
          z.union([
            RelativeJsonPathSchema(),
            McpbSourcePathSchema(),
            z.record(z.string(), McpServerConfigSchema()),
          ]),
        ),
      ])
      .optional(),
    lspServers: z
      .union([
        RelativeJsonPathSchema(),
        z.record(z.string(), LspServerConfigSchema()),
        z.array(
          z.union([
            RelativeJsonPathSchema(),
            z.record(z.string(), LspServerConfigSchema()),
          ]),
        ),
      ])
      .optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    userConfig: z
      .record(
        z.string().regex(/^[A-Za-z_]\w*$/),
        PluginUserConfigOptionSchema(),
      )
      .optional(),
  }),
)

export const MarketplaceNameSchema = lazySchema(() =>
  z
    .string()
    .min(1)
    .refine(
      name =>
        !name.includes(' ') &&
        !name.includes('/') &&
        !name.includes('\\') &&
        name !== '.' &&
        !name.includes('..') &&
        name !== 'inline' &&
        name !== 'builtin',
      'Invalid marketplace name',
    )
    .refine(
      name => !isBlockedOfficialName(name),
      'Marketplace name impersonates an official marketplace',
    ),
)

export const PluginSourceSchema = lazySchema(() =>
  z.union([
    RelativePathSchema(),
    z.strictObject({
      source: z.literal('npm'),
      package: z.string().min(1),
      version: z.string().optional(),
      registry: z.string().url().optional(),
    }),
    z.strictObject({
      source: z.literal('pip'),
      package: z.string().min(1),
      version: z.string().optional(),
      registry: z.string().url().optional(),
    }),
    z.strictObject({
      source: z.literal('url'),
      url: z.string().min(1),
      ref: z.string().optional(),
      sha: z
        .string()
        .regex(/^[0-9a-f]{40}$/i)
        .optional(),
    }),
    z.strictObject({
      source: z.literal('github'),
      repo: z.string().min(3),
      ref: z.string().optional(),
      sha: z
        .string()
        .regex(/^[0-9a-f]{40}$/i)
        .optional(),
    }),
    z.strictObject({
      source: z.literal('git-subdir'),
      url: z.string().min(1),
      path: z.string().min(1),
      ref: z.string().optional(),
      sha: z
        .string()
        .regex(/^[0-9a-f]{40}$/i)
        .optional(),
    }),
  ]),
)

export type PluginSourceSpec = z.infer<ReturnType<typeof PluginSourceSchema>>

export const PluginMarketplaceEntrySchema = lazySchema(() =>
  PluginManifestSchema()
    .partial()
    .extend({
      name: z
        .string()
        .min(1)
        .refine(s => !s.includes(' ')),
      source: PluginSourceSchema(),
      category: z.string().optional(),
      tags: z.array(z.string()).optional(),
      strict: z.boolean().optional().default(true),
    }),
)

export type PluginMarketplaceEntry = z.infer<
  ReturnType<typeof PluginMarketplaceEntrySchema>
>

export const MarketplaceSourceUnionSchema = lazySchema(() =>
  z.discriminatedUnion('source', [
    z.object({
      source: z.literal('url'),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).optional(),
    }),
    z.object({
      source: z.literal('github'),
      repo: z.string().min(3),
      ref: z.string().optional(),
      path: z.string().optional(),
      sparsePaths: z.array(z.string()).optional(),
    }),
    z.object({
      source: z.literal('git'),
      url: z.string().min(1),
      ref: z.string().optional(),
      path: z.string().optional(),
      sparsePaths: z.array(z.string()).optional(),
    }),
    z.object({
      source: z.literal('npm'),
      package: z.string().min(1),
    }),
    z.object({
      source: z.literal('file'),
      path: z.string().min(1),
    }),
    z.object({
      source: z.literal('directory'),
      path: z.string().min(1),
    }),
    z.object({
      source: z.literal('hostPattern'),
      hostPattern: z.string().min(1),
    }),
    z.object({
      source: z.literal('pathPattern'),
      pathPattern: z.string().min(1),
    }),
    z.object({
      source: z.literal('settings'),
      name: MarketplaceNameSchema(),
      plugins: z.array(PluginMarketplaceEntrySchema()),
      owner: PluginAuthorSchema().optional(),
    }),
  ]),
)

export type MarketplaceSource = z.infer<
  ReturnType<typeof MarketplaceSourceUnionSchema>
>

export const PluginMarketplaceSchema = lazySchema(() =>
  z.object({
    name: MarketplaceNameSchema(),
    owner: PluginAuthorSchema().optional(),
    plugins: z.array(PluginMarketplaceEntrySchema()),
    forceRemoveDeletedPlugins: z.boolean().optional(),
    metadata: z
      .object({
        pluginRoot: z.string().optional(),
        version: z.string().optional(),
        description: z.string().optional(),
      })
      .optional(),
    allowCrossMarketplaceDependenciesOn: z.array(z.string()).optional(),
  }),
)

export type PluginMarketplaceManifest = z.infer<
  ReturnType<typeof PluginMarketplaceSchema>
>

export const KnownMarketplaceRecordSchema = lazySchema(() =>
  z.object({
    source: MarketplaceSourceUnionSchema(),
    installLocation: z.string(),
    lastUpdated: z.string(),
    autoUpdate: z.boolean().optional(),
  }),
)

export type KnownMarketplaceRecord = z.infer<
  ReturnType<typeof KnownMarketplaceRecordSchema>
>

export const KnownMarketplacesFileSchema = lazySchema(() =>
  z.record(z.string(), KnownMarketplaceRecordSchema()),
)

export type PersistablePluginScope = 'managed' | 'user' | 'project' | 'local'

export const PluginInstallationEntrySchema = lazySchema(() =>
  z.object({
    scope: z.enum(['managed', 'user', 'project', 'local']),
    projectPath: z.string().optional(),
    installPath: z.string(),
    version: z.string().optional(),
    installedAt: z.string(),
    lastUpdated: z.string().optional(),
    gitCommitSha: z.string().optional(),
  }),
)

export type PluginInstallationEntry = z.infer<
  ReturnType<typeof PluginInstallationEntrySchema>
>

export const InstalledPluginsFileSchemaV2 = lazySchema(() =>
  z.object({
    version: z.literal(2),
    plugins: z.record(z.string(), z.array(PluginInstallationEntrySchema())),
  }),
)

export type InstalledPluginsFileV2 = z.infer<
  ReturnType<typeof InstalledPluginsFileSchemaV2>
>
