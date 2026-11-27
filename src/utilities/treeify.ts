export type TreeNode = {
  label: string
  children?: TreeNode[]
}

/**
 * Format a hierarchical tree structure into Unicode box-drawing lines.
 */
export function formatTree(nodes: readonly TreeNode[], prefix = ''): string[] {
  const lines: string[] = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    const isLast = i === nodes.length - 1
    const connector = isLast ? '└─ ' : '├─ '
    lines.push(`${prefix}${connector}${node.label}`)
    if (node.children && node.children.length > 0) {
      const childPrefix = prefix + (isLast ? '   ' : '│  ')
      lines.push(...formatTree(node.children, childPrefix))
    }
  }
  return lines
}

export function treeify(nodes: readonly TreeNode[]): string {
  return formatTree(nodes).join('\n')
}
