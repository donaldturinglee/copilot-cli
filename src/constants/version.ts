export function getMacroVersion(): string {
  const version = (
    globalThis as unknown as { MACRO?: { VERSION?: string } }
  ).MACRO?.VERSION
  return typeof version === 'string' && version.length > 0 ? version : '0.1.0'
}
