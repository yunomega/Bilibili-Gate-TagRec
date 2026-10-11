/** Cancel one waiter without cancelling a shared task; always consume the task's rejection. */
export function waitForAbortable<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task
  return new Promise<T>((resolve, reject) => {
    const detach = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      detach()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    task.then(
      (value) => {
        detach()
        resolve(value)
      },
      (error: unknown) => {
        detach()
        reject(error)
      },
    )
  })
}
