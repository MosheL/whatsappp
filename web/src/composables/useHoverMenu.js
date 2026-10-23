import { onUnmounted } from 'vue'

/**
 * Hover-opened menu controller: opens on pointer enter, closes on pointer
 * leave with a small grace delay so the pointer can travel between the trigger
 * button and the (possibly teleported) menu. Wire `onOpen`/`onClose` to
 * whatever state drives the menu.
 */
export function useHoverMenu({ onOpen, onClose, delay = 300 } = {}) {
  let timer = null

  function cancel() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function scheduleClose() {
    cancel()
    timer = setTimeout(() => {
      timer = null
      onClose?.()
    }, delay)
  }

  function open(...args) {
    cancel()
    onOpen?.(...args)
  }

  onUnmounted(cancel)

  return { open, scheduleClose, cancel }
}
