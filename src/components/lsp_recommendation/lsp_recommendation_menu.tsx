/**
 * Interactive prompt recommending an available marketplace LSP plugin when the
 * user edits a matching source file.
 */

import React, { useEffect, useRef } from 'react'
import { Box } from '../../ink/components/box.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'

const AUTO_DISMISS_MS = 30_000

export type LspRecommendationChoice = 'yes' | 'no' | 'never' | 'disable'

export interface LspRecommendationMenuProps {
  pluginName: string
  pluginDescription?: string
  fileExtension: string
  onResponse: (choice: LspRecommendationChoice) => void
}

/**
 * Renders the 4-choice LSP plugin recommendation dialog with a 30s auto-dismiss timer.
 */
export function LspRecommendationMenu({
  pluginName,
  pluginDescription,
  fileExtension,
  onResponse,
}: LspRecommendationMenuProps): React.ReactNode {
  const onResponseRef = useRef(onResponse)
  onResponseRef.current = onResponse

  useEffect(() => {
    const timer = setTimeout(() => {
      onResponseRef.current('no')
    }, AUTO_DISMISS_MS)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, [])

  return (
    <Dialog
      title="LSP Plugin Recommendation"
      subtitle={`Detected ${fileExtension} file`}
      borderColor="permission"
      onCancel={() => onResponse('no')}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText>
          Install LSP plugin &quot;{pluginName}&quot; for {fileExtension} code
          intelligence and automatic diagnostics?
        </ThemedText>
        {pluginDescription ? (
          <ThemedText dimColor>{pluginDescription}</ThemedText>
        ) : null}
        <Select
          options={[
            { label: `Yes, install ${pluginName}`, value: 'yes' },
            { label: 'No, not now', value: 'no' },
            { label: `Never suggest ${pluginName}`, value: 'never' },
            { label: 'Disable all LSP recommendations', value: 'disable' },
          ]}
          onChange={val => onResponse(val as LspRecommendationChoice)}
          onCancel={() => onResponse('no')}
        />
      </Box>
    </Dialog>
  )
}
