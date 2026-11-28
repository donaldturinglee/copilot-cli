/**
 * Interactive MCP Elicitation dialog supporting both `form` mode (validated
 * via `elicitation_validation.ts`) and `url` browser-consent mode.
 */

import React, { useState } from 'react'
import { Box } from '../../ink/components/box.js'
import type { ElicitationRequestEvent } from '../../types/forward.js'
import { openBrowser } from '../../utilities/browser.js'
import {
  coerceNumberValue,
  validateElicitationInput,
  type ElicitationObjectSchema,
} from '../../utilities/mcp/elicitation_validation.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'
import { TextInput } from '../text_input.js'

export interface ElicitationDialogProps {
  event: ElicitationRequestEvent
  onDone: () => void
}

/**
 * Renders an MCP server elicitation prompt from `AppState.elicitation.queue`.
 */
export function ElicitationDialog({
  event,
  onDone,
}: ElicitationDialogProps): React.ReactNode {
  const mode = event.mode === 'url' ? 'url' : 'form'
  const schema = (event.requestedSchema ?? {}) as ElicitationObjectSchema
  const fieldEntries = Object.entries(schema.properties ?? {})
  const [fieldIdx, setFieldIdx] = useState(0)
  const [draftValues, setDraftValues] = useState<Record<string, unknown>>({})
  const [currentInput, setCurrentInput] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const finish = (result: {
    action: 'accept' | 'decline' | 'cancel'
    content?: Record<string, unknown>
  }) => {
    event.resolve?.(result)
    onDone()
  }

  if (mode === 'url') {
    const targetUrl = typeof event.url === 'string' ? event.url : ''
    return (
      <Dialog
        title={`Input Requested by ${event.serverName}`}
        borderColor="permission"
        onCancel={() => finish({ action: 'cancel' })}
      >
        <Box flexDirection="column" gap={1}>
          {event.message ? <ThemedText>{event.message}</ThemedText> : null}
          {targetUrl ? <ThemedText color="suggestion">{targetUrl}</ThemedText> : null}
          <Select
            options={[
              { label: 'Open URL in browser and continue', value: 'open' },
              { label: 'Decline', value: 'decline' },
              { label: 'Cancel', value: 'cancel' },
            ]}
            onChange={choice => {
              if (choice === 'open') {
                if (targetUrl) {
                  void openBrowser(targetUrl)
                }
                finish({ action: 'accept', content: {} })
              } else if (choice === 'decline') {
                finish({ action: 'decline' })
              } else {
                finish({ action: 'cancel' })
              }
            }}
            onCancel={() => finish({ action: 'cancel' })}
          />
        </Box>
      </Dialog>
    )
  }

  if (fieldEntries.length === 0) {
    return (
      <Dialog
        title={`Confirm Request from ${event.serverName}`}
        borderColor="permission"
        onCancel={() => finish({ action: 'cancel' })}
      >
        <Box flexDirection="column" gap={1}>
          {event.message ? <ThemedText>{event.message}</ThemedText> : null}
          <Select
            options={[
              { label: 'Accept', value: 'accept' },
              { label: 'Decline', value: 'decline' },
              { label: 'Cancel', value: 'cancel' },
            ]}
            onChange={val =>
              finish({
                action: val as 'accept' | 'decline' | 'cancel',
                ...(val === 'accept' ? { content: {} } : {}),
              })
            }
            onCancel={() => finish({ action: 'cancel' })}
          />
        </Box>
      </Dialog>
    )
  }

  const [activeKey, activeSchema] = fieldEntries[fieldIdx] ?? fieldEntries[0]!

  const handleFieldSubmit = (raw: string) => {
    let parsedVal: unknown = raw
    if (activeSchema.type === 'number' || activeSchema.type === 'integer') {
      const num = coerceNumberValue(raw, activeSchema.type === 'integer')
      if (num === null) {
        setErrorMessage(`Invalid ${activeSchema.type} value`)
        return
      }
      parsedVal = num
    } else if (activeSchema.type === 'boolean') {
      parsedVal = raw.trim().toLowerCase() === 'true' || raw.trim() === 'yes'
    }

    const nextValues = { ...draftValues, [activeKey]: parsedVal }
    if (fieldIdx + 1 < fieldEntries.length) {
      setDraftValues(nextValues)
      setCurrentInput('')
      setErrorMessage(null)
      setFieldIdx(fieldIdx + 1)
      return
    }

    const validation = validateElicitationInput(nextValues, schema)
    if (!validation.valid) {
      const firstErr = Object.entries(validation.errors)[0]
      setErrorMessage(
        firstErr ? `${firstErr[0]}: ${firstErr[1]}` : 'Validation failed',
      )
      return
    }
    finish({ action: 'accept', content: nextValues })
  }

  return (
    <Dialog
      title={`Input Requested by ${event.serverName}`}
      subtitle={`Field ${fieldIdx + 1} of ${fieldEntries.length}`}
      borderColor="permission"
      onCancel={() => finish({ action: 'cancel' })}
    >
      <Box flexDirection="column" gap={1}>
        {event.message ? <ThemedText>{event.message}</ThemedText> : null}
        <ThemedText bold>
          {activeSchema.title ?? activeKey}
          {activeSchema.description ? ` — ${activeSchema.description}` : ''}
        </ThemedText>
        <TextInput
          value={currentInput}
          onChange={setCurrentInput}
          onSubmit={handleFieldSubmit}
        />
        {errorMessage ? (
          <ThemedText color="error">{errorMessage}</ThemedText>
        ) : null}
      </Box>
    </Dialog>
  )
}
