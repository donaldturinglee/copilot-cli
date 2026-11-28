/**
 * Prompt and description strings for `LSPTool` (`LSP`).
 */

export const LSP_TOOL_DESCRIPTION =
  'Query Language Server Protocol (LSP) servers for definitions, references, hover types, symbols, implementations, and call hierarchies.'

export const LSP_TOOL_PROMPT = `Interact with active Language Server Protocol (LSP) servers for accurate semantic code navigation.

Supported \`operation\` values (both \`line\` and \`character\` are **1-based**):
- \`goToDefinition\`: Jump to the symbol's definition.
- \`findReferences\`: Find all references to the symbol across the workspace.
- \`hover\`: Inspect resolved type signatures and documentation comments.
- \`documentSymbol\`: List hierarchical symbols in \`filePath\`.
- \`workspaceSymbol\`: Search symbols across the workspace.
- \`goToImplementation\`: Find concrete implementations of an interface or abstract method.
- \`prepareCallHierarchy\`: Inspect the callable symbol at \`filePath:line:character\`.
- \`incomingCalls\`: List callers invoking the symbol at \`filePath:line:character\`.
- \`outgoingCalls\`: List callees invoked inside the symbol at \`filePath:line:character\`.`
