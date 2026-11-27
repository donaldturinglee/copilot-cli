/**
 * Low-level ASCII / C0 / C1 control byte constants for VT/ANSI streams.
 */

export const NUL = '\x00'
export const BEL = '\x07'
export const BS = '\x08'
export const HT = '\x09'
export const LF = '\x0a'
export const CR = '\x0d'
export const ESC = '\x1b'
export const DEL = '\x7f'

export const CSI = '\x1b['
export const OSC = '\x1b]'
export const DCS = '\x1bP'
export const ST = '\x1b\\'

export const ESC_CODE = 0x1b
export const BEL_CODE = 0x07
