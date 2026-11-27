export type FpsMetrics = {
  fps: number
  frameCount: number
  droppedFrames: number
  avgFrameMs: number
  maxFrameMs: number
  p95FrameMs: number
}

const WINDOW_SIZE = 120
const FRAME_BUDGET_MS = 16.67

/**
 * Ring-buffer frame timing tracker for monitoring 60fps TUI render health.
 */
export class FpsTracker {
  private readonly durations: Float64Array = new Float64Array(WINDOW_SIZE)
  private writeIndex = 0
  private sampleCount = 0
  private totalFrames = 0
  private droppedFrames = 0
  private lastFrameTimestamp = 0

  recordFrame(durationMs: number, now: number = performance.now()): void {
    this.durations[this.writeIndex] = durationMs
    this.writeIndex = (this.writeIndex + 1) % WINDOW_SIZE
    if (this.sampleCount < WINDOW_SIZE) {
      this.sampleCount++
    }
    this.totalFrames++
    if (durationMs > FRAME_BUDGET_MS) {
      this.droppedFrames++
    }
    this.lastFrameTimestamp = now
  }

  getLastFrameTimestamp(): number {
    return this.lastFrameTimestamp
  }

  getMetrics(): FpsMetrics {
    if (this.sampleCount === 0) {
      return {
        fps: 0,
        frameCount: 0,
        droppedFrames: 0,
        avgFrameMs: 0,
        maxFrameMs: 0,
        p95FrameMs: 0,
      }
    }

    const sorted: number[] = new Array(this.sampleCount)
    let sum = 0
    let max = 0
    for (let i = 0; i < this.sampleCount; i++) {
      const d = this.durations[i]!
      sorted[i] = d
      sum += d
      if (d > max) max = d
    }
    sorted.sort((a, b) => a - b)

    const avg = sum / this.sampleCount
    const p95Idx = Math.min(
      this.sampleCount - 1,
      Math.floor(this.sampleCount * 0.95),
    )
    const p95 = sorted[p95Idx]!
    const fps = avg > 0 ? Math.min(120, Math.round((1000 / Math.max(avg, FRAME_BUDGET_MS)) * 10) / 10) : 60

    return {
      fps,
      frameCount: this.totalFrames,
      droppedFrames: this.droppedFrames,
      avgFrameMs: Math.round(avg * 100) / 100,
      maxFrameMs: Math.round(max * 100) / 100,
      p95FrameMs: Math.round(p95 * 100) / 100,
    }
  }

  reset(): void {
    this.writeIndex = 0
    this.sampleCount = 0
    this.totalFrames = 0
    this.droppedFrames = 0
    this.lastFrameTimestamp = 0
  }
}
