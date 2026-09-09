// Share concurrent GETs, but never reuse completed message responses.
export function createRequestPool() {
  const pending = new Map()
  return {
    run(key, scope, fetcher) {
      if (pending.has(key)) return pending.get(key).promise
      const controller = new AbortController()
      const entry = { scope, controller }
      entry.promise = Promise.resolve().then(() => fetcher(controller.signal)).finally(() => {
        if (pending.get(key) === entry) pending.delete(key)
      })
      pending.set(key, entry)
      return entry.promise
    },
    cancel(predicate = () => true) {
      for (const [key, entry] of pending) {
        if (!predicate(entry.scope)) continue
        pending.delete(key)
        entry.controller.abort()
      }
    }
  }
}
