/**
 * PowerShell common parameters and alternative parameter prefix normalization.
 */

import { PS_TOKENIZER_DASH_CHARS } from '../../utilities/powershell/parser.js'

export const POWERSHELL_COMMON_PARAMETERS: ReadonlySet<string> = new Set([
  '-verbose',
  '-vb',
  '-debug',
  '-db',
  '-erroraction',
  '-ea',
  '-warningaction',
  '-wa',
  '-informationaction',
  '-infa',
  '-errorvariable',
  '-ev',
  '-warningvariable',
  '-wv',
  '-informationvariable',
  '-iv',
  '-outvariable',
  '-ov',
  '-outbuffer',
  '-ob',
  '-pipelinevariable',
  '-pv',
  '-progressaction',
  '-whatif',
  '-confirm',
])

export function normalizePsParam(arg: string): string {
  if (!arg) return arg
  const first = arg[0]!
  if (PS_TOKENIZER_DASH_CHARS.has(first)) {
    return '-' + arg.slice(1).split(':')[0]!.toLowerCase()
  }
  return arg.toLowerCase()
}

export function isPowerShellCommonParameter(arg: string): boolean {
  return POWERSHELL_COMMON_PARAMETERS.has(normalizePsParam(arg))
}
