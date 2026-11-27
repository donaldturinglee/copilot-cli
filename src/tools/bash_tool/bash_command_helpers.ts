/**
 * Wrapper-stripping and compound operator helpers shared by `bash_permissions`
 * and `should_use_sandbox`.
 */

const ENV_VAR_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)/

export const BINARY_HIJACK_VARS = new Set([
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'PYTHONPATH',
  'NODE_OPTIONS',
  'RUBYOPT',
  'PERL5OPT',
  'BASH_ENV',
  'ENV',
  'IFS',
  'ZDOTDIR',
])

export const SAFE_ENV_VARS = new Set([
  'NODE_ENV',
  'CI',
  'DEBUG',
  'VERBOSE',
  'FORCE_COLOR',
  'NO_COLOR',
  'TERM',
  'LANG',
  'LC_ALL',
  'TZ',
  'RUST_BACKTRACE',
  'RUST_LOG',
  'GOFLAGS',
  'CGO_ENABLED',
  'PYTHONDONTWRITEBYTECODE',
  'PYTHONUNBUFFERED',
  'VITEST',
  'JEST_WORKER_ID',
])

/**
 * Strips leading `VAR=val` assignments unless the variable is in `blockedVars`
 * (or not safe when `onlySafe` is true).
 */
export function stripLeadingEnvVars(
  command: string,
  options?: { blockedVars?: ReadonlySet<string>; onlySafe?: boolean },
): string {
  let rest = command.trim()
  while (true) {
    const match = rest.match(ENV_VAR_ASSIGN_RE)
    if (!match) break
    const assignment = match[0]
    const varName = assignment.slice(0, assignment.indexOf('='))
    if (options?.blockedVars?.has(varName)) {
      break
    }
    if (options?.onlySafe && !SAFE_ENV_VARS.has(varName)) {
      break
    }
    const after = rest.slice(assignment.length)
    if (!after || !/^\s/.test(after)) {
      break
    }
    rest = after.trimStart()
  }
  return rest
}

/**
 * Strips safe execution wrappers (`timeout <dur>`, `nice [-n N]`, `nohup`,
 * `time`, `stdbuf -oL ...`) to inspect the wrapped underlying command.
 */
export function stripSafeWrappers(command: string): string {
  let current = command.trim()
  let changed = true

  while (changed) {
    changed = false
    const tokens = current.split(/\s+/)
    const first = tokens[0]
    if (!first) break

    if (first === 'nohup' || first === 'time') {
      if (tokens.length > 1) {
        current = tokens.slice(1).join(' ')
        changed = true
      }
      continue
    }

    if (first === 'timeout') {
      let i = 1
      while (i < tokens.length && tokens[i]!.startsWith('-')) {
        if (tokens[i] === '-s' || tokens[i] === '-k' || tokens[i] === '--signal' || tokens[i] === '--kill-after') {
          i += 2
        } else {
          i++
        }
      }
      // Skip duration arg
      if (i < tokens.length && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[i]!)) {
        i++
      }
      if (i < tokens.length) {
        current = tokens.slice(i).join(' ')
        changed = true
      }
      continue
    }

    if (first === 'nice') {
      let i = 1
      if (tokens[i] === '-n' && i + 1 < tokens.length) {
        i += 2
      } else if (tokens[i] && /^-\d+$/.test(tokens[i]!)) {
        i++
      }
      if (i < tokens.length) {
        current = tokens.slice(i).join(' ')
        changed = true
      }
      continue
    }

    if (first === 'stdbuf') {
      let i = 1
      while (i < tokens.length && tokens[i]!.startsWith('-')) {
        if (/^-[ioe]$/.test(tokens[i]!)) {
          i += 2
        } else {
          i++
        }
      }
      if (i < tokens.length) {
        current = tokens.slice(i).join(' ')
        changed = true
      }
      continue
    }
  }

  return current
}

/**
 * Produces the fixed-point closure of candidate command strings formed by
 * iteratively stripping non-hijack env vars and safe wrappers.
 */
export function expandCommandCandidates(command: string): string[] {
  const trimmed = command.trim()
  const candidates = [trimmed]
  const seen = new Set(candidates)
  let idx = 0
  while (idx < candidates.length && candidates.length < 16) {
    const cur = candidates[idx++]!
    const envStripped = stripLeadingEnvVars(cur, {
      blockedVars: BINARY_HIJACK_VARS,
    })
    if (!seen.has(envStripped)) {
      seen.add(envStripped)
      candidates.push(envStripped)
    }
    const wrapperStripped = stripSafeWrappers(cur)
    if (!seen.has(wrapperStripped)) {
      seen.add(wrapperStripped)
      candidates.push(wrapperStripped)
    }
  }
  return candidates
}
