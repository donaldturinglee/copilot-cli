export const EXIT_WORKTREE_TOOL_DESCRIPTION =
  'Exits an active git worktree session created by EnterWorktree, either keeping or removing the worktree and branch.'

export const EXIT_WORKTREE_TOOL_PROMPT = `Exits the current EnterWorktree session and restores the original working directory.
- \`action: "keep"\` leaves the worktree directory and branch on disk.
- \`action: "remove"\` removes the worktree and deletes its branch; fails closed if uncommitted files or unmerged commits exist unless \`discard_changes: true\` is explicitly provided.`
