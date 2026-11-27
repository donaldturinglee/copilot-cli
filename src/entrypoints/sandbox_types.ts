/**
 * Public TypeScript contracts for OS-level command sandboxing
 * (`@anthropic-ai/sandbox-runtime` integration).
 */

export interface SandboxNetworkRuntimeConfig {
  allowedDomains: string[]
  deniedDomains: string[]
  allowUnixSockets?: string[]
  allowAllUnixSockets?: boolean
  allowLocalBinding?: boolean
  httpProxyPort?: number
  socksProxyPort?: number
}

export interface SandboxFilesystemRuntimeConfig {
  denyRead: string[]
  allowRead?: string[]
  allowWrite: string[]
  denyWrite: string[]
  allowGitConfig?: boolean
}

export interface SandboxRuntimeConfig {
  network: SandboxNetworkRuntimeConfig
  filesystem: SandboxFilesystemRuntimeConfig
  ignoreViolations?: Record<string, string[]>
  enableWeakerNestedSandbox?: boolean
  enableWeakerNetworkIsolation?: boolean
  ripgrep?: {
    command: string
    args?: string[]
  }
  mandatoryDenySearchDepth?: number
}

export interface SandboxViolationEvent {
  line: string
  command?: string
  encodedCommand?: string
  timestamp: Date
}

export interface SandboxDependencyCheck {
  errors: string[]
  warnings: string[]
}

export type SandboxAskCallback = (params: {
  host: string
  port: number
}) => Promise<boolean>

export interface SandboxViolationStoreLike {
  getViolations(limit?: number): SandboxViolationEvent[]
  getTotalCount(): number
  getViolationsForCommand(command: string): SandboxViolationEvent[]
  clear(): void
}
