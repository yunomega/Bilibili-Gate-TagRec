/** Extra verification/dig batches follow scrolling, with a quiet interval and a no-progress stop. */
export class TagRecAutoContinuation {
  private finishedAt = -Infinity
  private running = false
  private emptyRounds = 0
  get stalled() {
    return this.emptyRounds >= 2
  }
  delay(now: number) {
    if (this.running || this.stalled) return undefined
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
  }
  resume() {
    this.emptyRounds = 0
  }
}
