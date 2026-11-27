import React, { useMemo } from 'react'
import { DiagnosticsDisplay } from '../components/diagnostics_display.js'
import { Dialog } from '../components/design_system/dialog.js'
import { ThemedText } from '../components/design_system/themed_text.js'
import { Box } from '../ink/components/box.js'
import {
  type DoctorReport,
  runDoctorDiagnostics,
} from '../utilities/doctor_diagnostic.js'

export type DoctorScreenProps = {
  report?: DoctorReport
  cwd?: string
  onDone: (summary?: string) => void
}

/**
 * Interactive `/doctor` diagnostic screen showing environment, settings,
 * keybindings, and workspace health checks.
 */
export function Doctor({
  report,
  cwd,
  onDone,
}: DoctorScreenProps): React.ReactNode {
  const resolved = useMemo(
    () => report ?? runDoctorDiagnostics({ cwd }),
    [report, cwd],
  )

  return (
    <Dialog
      title={`Copilot CLI Doctor v${resolved.version}`}
      subtitle={
        resolved.hasFailures
          ? 'Issues detected — review failed checks below'
          : 'All critical checks passed'
      }
      borderColor={resolved.hasFailures ? 'error' : 'success'}
      width={76}
      overlayId="doctor-screen"
      onCancel={() => onDone()}
    >
      <Box flexDirection="column" gap={1}>
        <DiagnosticsDisplay checks={resolved.checks} />
        <ThemedText
          color={resolved.hasFailures ? 'error' : 'success'}
          bold
        >
          {resolved.hasFailures
            ? 'Doctor found issues that require attention.'
            : 'Everything looks healthy! Press Esc to return to REPL.'}
        </ThemedText>
      </Box>
    </Dialog>
  )
}
