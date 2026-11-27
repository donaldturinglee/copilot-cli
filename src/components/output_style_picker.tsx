import React, { useMemo } from 'react'
import { Box } from '../ink/components/box.js'
import { loadOutputStyles } from '../output_styles/load_output_styles_dir.js'
import { Select } from './custom_select/select.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'

export type OutputStylePickerProps = {
  currentStyle?: string
  onSelect: (styleName: string) => void
  onCancel: () => void
}

export function OutputStylePicker({
  currentStyle = 'default',
  onSelect,
  onCancel,
}: OutputStylePickerProps): React.ReactNode {
  const styles = useMemo(() => Object.values(loadOutputStyles()), [])

  return (
    <Dialog
      title="Output Style (/output-style)"
      subtitle={`Current: ${currentStyle}`}
      width={72}
      overlayId="output-style-picker"
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <Select
          defaultValue={currentStyle}
          options={styles.map(s => ({
            label: `${s.name} (${s.source})`,
            value: s.name,
            description: s.description,
          }))}
          onChange={onSelect}
          onCancel={onCancel}
        />
        <ThemedText dimColor>
          Add custom styles in ~/.copilot/output-styles/*.md or .copilot/output-styles/*.md
        </ThemedText>
      </Box>
    </Dialog>
  )
}
