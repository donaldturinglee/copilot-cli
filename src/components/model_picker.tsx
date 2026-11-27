import React from 'react'
import { Box } from '../ink/components/box.js'
import { Select } from './custom_select/select.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'

export const AVAILABLE_MODELS = [
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6 (Default)',
    description: 'Balanced speed, intelligence, and coding quality',
  },
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    description: 'Maximum reasoning depth for complex engineering tasks',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    description: 'Fastest low-latency responses',
  },
] as const

export type ModelPickerProps = {
  currentModel?: string | null
  onSelect: (modelId: string) => void
  onCancel: () => void
}

export function ModelPicker({
  currentModel,
  onSelect,
  onCancel,
}: ModelPickerProps): React.ReactNode {
  return (
    <Dialog
      title="Select Model (/model)"
      subtitle={`Current: ${currentModel ?? 'default (claude-sonnet-4-6)'}`}
      width={70}
      overlayId="model-picker"
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <Select
          defaultValue={currentModel ?? AVAILABLE_MODELS[0].id}
          options={AVAILABLE_MODELS.map(m => ({
            label: m.label,
            value: m.id,
            description: m.description,
          }))}
          onChange={onSelect}
          onCancel={onCancel}
        />
        <ThemedText dimColor>Enter to apply · Esc to cancel</ThemedText>
      </Box>
    </Dialog>
  )
}
