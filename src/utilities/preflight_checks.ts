import { runDoctorDiagnostics } from './doctor_diagnostic.js'

export type PreflightResult = {
  ok: boolean
  warnings: string[]
  errors: string[]
}

export function runPreflightChecks(cwd?: string): PreflightResult {
  const report = runDoctorDiagnostics({ cwd })
  const warnings = report.checks
    .filter(c => c.status === 'warn')
    .map(c => `${c.label}: ${c.detail}`)
  const errors = report.checks
    .filter(c => c.status === 'fail')
    .map(c => `${c.label}: ${c.detail}`)
  return {
    ok: errors.length === 0,
    warnings,
    errors,
  }
}
