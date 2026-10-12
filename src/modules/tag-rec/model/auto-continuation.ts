/** Extra verification/dig batches follow scrolling, with a quiet interval and a no-progress cooldown. */
export class TagRecAutoContinuation {
  private finishedAt = -Infinity
  private running = false
  private emptyRounds = 0
  private stalledAt = -Infinity
  get stalled() {
    return this.emptyRounds >= 2
  }
  delay(now: number) {
    if (this.running) return undefined
    if (this.stalled) return Math.max(0, this.stalledAt + 60_000 - now)
    return Math.max(0, 8_000 - (now - this.finishedAt))
  }
  start(now: number) {
    if (this.delay(now) !== 0) return false
    this.running = true
    return true
  }
  finish(now: number, added: number) {
    this.running = false
    this.finishedAt = now
    this.emptyRounds = added > 0 ? 0 : this.emptyRounds + 1
    if (this.stalled) this.stalledAt = now
  }
  resume() {
    this.emptyRounds = 0
    this.stalledAt = -Infinity
  }
}
