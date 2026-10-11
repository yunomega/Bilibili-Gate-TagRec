/** A cancelled wait releases its timer and listener immediately, including injected test sleepers. */
export function abortableDelay(ms: number, signal?: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const detach = () => {
      signal?.removeEventListener('abort', onAbort)
      if (timer !== undefined) clearTimeout(timer)
    }
    const onAbort = () => {
      detach()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (sleep) {
      Promise.resolve()
        .then(() => {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
          return sleep(ms)
        })
        .then(
          () => {
            detach()
            resolve()
          },
          (error: unknown) => {
            detach()
            reject(error)
          },
        )
    } else {
      timer = setTimeout(() => {
        detach()
        resolve()
      }, ms)
    }
  })
}
