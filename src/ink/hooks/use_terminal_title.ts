import { useEffect } from 'react'
import { setTerminalTitle } from '../../utilities/terminal.js'

export function useTerminalTitle(title: string | undefined): void {
  useEffect(() => {
    if (!title) return
    setTerminalTitle(title)
  }, [title])
}
