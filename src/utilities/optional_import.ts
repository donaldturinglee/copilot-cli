/**
 * Dynamic loader for optional cloud-provider SDKs (Bedrock, Vertex, Foundry,
 * AWS SDK, Google Auth Library, Azure Identity) with test override support.
 */

const testModuleOverrides = new Map<string, unknown>()

/**
 * Registers an optional-module override in tests so cloud provider adapters can
 * be unit-tested deterministically without installing third-party SDKs.
 */
export function registerOptionalModuleForTesting(
  specifier: string,
  moduleExports: unknown,
): void {
  testModuleOverrides.set(specifier, moduleExports)
}

/**
 * Clears all optional-module overrides registered for tests.
 */
export function clearOptionalModuleOverridesForTesting(): void {
  testModuleOverrides.clear()
}

/**
 * Dynamically imports an optional runtime module by specifier.
 * Throws a clear installation error if the package is unavailable.
 */
export async function importOptionalModule<ModuleShape>(
  specifier: string,
  purpose?: string,
): Promise<ModuleShape> {
  if (testModuleOverrides.has(specifier)) {
    return testModuleOverrides.get(specifier) as ModuleShape
  }
  try {
    // Indirect specifier prevents static bundler/TS module resolution failures
    // when optional cloud SDKs are not installed.
    const dynamicSpecifier: string = specifier
    return (await import(dynamicSpecifier)) as ModuleShape
  } catch (error) {
    const context = purpose ? ` for ${purpose}` : ''
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Optional package "${specifier}" is required${context}. Install it to enable this provider (${detail}).`,
    )
  }
}
