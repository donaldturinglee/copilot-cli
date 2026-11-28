/**
 * Reconstructed static Markdown prompt and language example files for the
 * bundled `/verify` skill.
 */

export const VERIFY_SKILL_MD = `Verify the recent changes end-to-end by running real build, type-check, unit test, and integration commands in this workspace.

Steps:
1. Inspect \`git status\` and \`git diff\` to identify every modified subsystem and public contract.
2. Run the project's type checker and test suite, covering both happy paths and edge/error cases.
3. For CLI tools or servers, run realistic end-to-end invocations and check exit codes, stdout/stderr, and side effects.
4. Report concrete verification evidence or fix any regressions before concluding.`

export const VERIFY_SKILL_FILES: Readonly<Record<string, string>> = {
  'examples/cli.md': `# CLI Verification Checklist

1. Run \`--help\` and \`--version\` to confirm bootstrap and CLI flag parsing succeed cleanly.
2. Execute representative non-interactive commands in an isolated temporary directory.
3. Verify non-zero exit codes and actionable stderr messages on invalid inputs.`,
  'examples/server.md': `# Server & Protocol Verification Checklist

1. Start the server on an ephemeral port (\`0\`) or in-memory transport.
2. Exercise handshake, authenticated requests, invalid payloads, and clean shutdown.
3. Confirm no dangling child processes, open sockets, or temp files remain after teardown.`,
}
