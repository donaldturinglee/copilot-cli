/**
 * Shared prompt rendering & JSON response extraction helper for `prompt` and
 * `agent` hooks.
 */

export interface HookVerificationDecision {
  ok: boolean
  reason?: string
}

export function renderHookPrompt(promptTemplate: string, jsonInput: string): string {
  if (promptTemplate.includes('$ARGUMENTS')) {
    return promptTemplate.replace(/\$ARGUMENTS/g, jsonInput)
  }
  return `${promptTemplate}\n\nHook input JSON:\n${jsonInput}`
}

/**
 * Extracts a `{ ok: boolean, reason?: string }` verdict from model text
 * (supporting bare JSON or fenced ```json blocks). Fails closed (`ok: false`)
 * if no valid decision object is found.
 */
export function parseHookVerificationVerdict(
  rawText: string,
): HookVerificationDecision {
  const trimmed = rawText.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1]?.trim() ?? trimmed

  // Try direct JSON parse or first `{...}` block
  const jsonStart = candidate.indexOf('{')
  const jsonEnd = candidate.lastIndexOf('}')
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(candidate.slice(jsonStart, jsonEnd + 1)) as Record<
        string,
        unknown
      >
      if (typeof parsed.ok === 'boolean') {
        return {
          ok: parsed.ok,
          ...(typeof parsed.reason === 'string' ? { reason: parsed.reason } : {}),
        }
      }
      if (parsed.decision === 'approve') {
        return { ok: true, reason: typeof parsed.reason === 'string' ? parsed.reason : undefined }
      }
      if (parsed.decision === 'block') {
        return {
          ok: false,
          reason:
            typeof parsed.reason === 'string'
              ? parsed.reason
              : 'Blocked by verification hook',
        }
      }
    } catch {
      // fall through
    }
  }

  return {
    ok: false,
    reason: `Verification hook returned unparseable verdict: ${trimmed.slice(0, 200)}`,
  }
}
