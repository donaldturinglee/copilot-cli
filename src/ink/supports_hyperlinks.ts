import { terminalSupportsHyperlinks } from '../utilities/hyperlink.js'

export function supportsHyperlinks(): boolean {
  return terminalSupportsHyperlinks()
}
