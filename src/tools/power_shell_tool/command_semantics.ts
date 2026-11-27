/**
 * Semantic exit code interpretation for PowerShell commands.
 */

export function interpretPowerShellResult(
  exitCode: number,
  stderr: string,
): { isError: boolean; message?: string } {
  if (exitCode === 0) {
    return { isError: false }
  }
  return {
    isError: true,
    message: stderr.trim() || `PowerShell exited with code ${exitCode}`,
  }
}
