/**
 * Age-scaled timestamp formatting for chat/brief message labels with POSIX
 * locale (`LC_ALL` > `LC_TIME` > `LANG`) conversion to BCP 47.
 */

function getLocale(): string | undefined {
  const raw =
    process.env.LC_ALL || process.env.LC_TIME || process.env.LANG || ''
  if (!raw || raw === 'C' || raw === 'POSIX') {
    return undefined
  }
  const base = raw.split('.')[0]?.split('@')[0] ?? ''
  if (!base) {
    return undefined
  }
  const tag = base.replaceAll('_', '-')
  try {
    new Intl.DateTimeFormat(tag)
    return tag
  } catch {
    return undefined
  }
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * Formats an ISO timestamp relative to `now`:
 * - same day: `"1:30 PM"`
 * - within 6 days: `"Sunday, 4:15 PM"`
 * - older: `"Sunday, Feb 20, 4:30 PM"`
 */
export function formatBriefTimestamp(
  isoString: string,
  now: Date = new Date(),
): string {
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const locale = getLocale()
  const dayDiff = startOfDay(now) - startOfDay(date)
  const daysAgo = Math.round(dayDiff / 86_400_000)

  if (daysAgo === 0) {
    return date.toLocaleTimeString(locale, {
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  if (daysAgo > 0 && daysAgo < 7) {
    return date.toLocaleString(locale, {
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  return date.toLocaleString(locale, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
