/** RFC 9110 section 10.2.3: delay-seconds or HTTP-date; never truncate a server wait to our local backoff cap. */
export function retryAfterDelay(
  headers: string | Record<string, unknown> | undefined,
  now = Date.now(),
): number | undefined {
  if (!headers) return undefined
  // GM supplies raw header lines; Axios supplies a header map. HTTP dates contain
  // commas, so never split a Retry-After value on commas when sharing this parser.
  const entries =
    typeof headers === 'string'
      ? headers.split(/\r?\n/).flatMap((line) => {
          const colon = line.indexOf(':')
          return colon === -1 ? [] : [[line.slice(0, colon), line.slice(colon + 1)] as const]
        })
      : Object.entries(headers)
  let longest: number | undefined
  for (const [name, raw] of entries) {
    if (name.trim().toLowerCase() !== 'retry-after') continue
    for (const part of Array.isArray(raw) ? raw : [raw]) {
      if (typeof part !== 'string' && typeof part !== 'number') continue
      const value = String(part).trim()
      let delay: number
      if (/^\d+$/.test(value)) delay = Number(value) * 1_000
      else {
        // Date.parse also accepts bare numbers/fractions; these are not HTTP dates.
        if (!/[a-z]{3}/i.test(value)) continue
        delay = Math.max(0, Date.parse(value) - now)
      }
      if (!Number.isFinite(delay) || delay < 0) continue
      longest = Math.max(longest ?? 0, delay)
    }
  }
  return longest
}
