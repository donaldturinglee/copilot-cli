import { ESC } from './ansi.js'

/**
 * 2-byte ESC sequences (DECSC / DECRC / RIS / IND / RI).
 */

export const SAVE_CURSOR = `${ESC}7`
export const RESTORE_CURSOR = `${ESC}8`
export const FULL_RESET = `${ESC}c`
export const REVERSE_INDEX = `${ESC}M`
export const INDEX = `${ESC}D`
export const NEXT_LINE = `${ESC}E`
export const KEYPAD_APPLICATION = `${ESC}=`
export const KEYPAD_NUMERIC = `${ESC}>`
