/**
 * High-level `ParsedCommand` wrapper providing ergonomic AST accessors.
 */

import {
  extractCommandArguments,
  type ParsedCommandData,
  parseCommand,
} from './parser.js'

export class ParsedCommand {
  readonly data: ParsedCommandData

  constructor(data: ParsedCommandData) {
    this.data = data
  }

  static async parse(command: string): Promise<ParsedCommand | null> {
    const parsed = await parseCommand(command)
    return parsed ? new ParsedCommand(parsed) : null
  }

  get originalCommand(): string {
    return this.data.originalCommand
  }

  get envVars(): readonly string[] {
    return this.data.envVars
  }

  get argv(): string[] {
    if (!this.data.commandNode) return []
    return extractCommandArguments(this.data.commandNode)
  }

  get commandName(): string | null {
    return this.argv[0] ?? null
  }
}
