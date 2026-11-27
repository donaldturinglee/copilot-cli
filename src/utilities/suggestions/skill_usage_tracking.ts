export type SkillUsageRecord = {
  count: number
  lastUsedAt: number
}

const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days exponential decay
const usageStore = new Map<string, SkillUsageRecord>()

export function recordSkillUsage(name: string, nowMs = Date.now()): void {
  const key = name.toLowerCase()
  const existing = usageStore.get(key)
  usageStore.set(key, {
    count: (existing?.count ?? 0) + 1,
    lastUsedAt: nowMs,
  })
}

export function getSkillUsageBoost(name: string, nowMs = Date.now()): number {
  const rec = usageStore.get(name.toLowerCase())
  if (!rec) return 0
  const ageMs = Math.max(0, nowMs - rec.lastUsedAt)
  const decay = Math.pow(0.5, ageMs / HALF_LIFE_MS)
  return Math.min(25, Math.log2(rec.count + 1) * 10 * decay)
}

export function resetSkillUsageTracking(): void {
  usageStore.clear()
}
