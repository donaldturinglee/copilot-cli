export type SpinnerMode =
  | 'requesting'
  | 'thinking'
  | 'responding'
  | 'tool-use'
  | 'stalled'

export const SPINNER_FRAME_INTERVAL_MS = 50 // 20Hz animation clock
export const SPINNER_STALL_THRESHOLD_MS = 3000 // 3s stall reddening threshold
