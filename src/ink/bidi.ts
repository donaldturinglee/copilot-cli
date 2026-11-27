/**
 * Strip Unicode bidirectional control characters that can spoof terminal layout
 * or corrupt left-to-right grid column alignment.
 */
const BIDI_CONTROL_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

export function stripBidiControls(text: string): string {
  return text.replace(BIDI_CONTROL_RE, '')
}

export function hasBidiControls(text: string): boolean {
  BIDI_CONTROL_RE.lastIndex = 0
  return BIDI_CONTROL_RE.test(text)
}
