import { reactive } from 'vue'

// Toast system: a single reactive store + Toaster component. Based on the
// classic reactive-module pattern — no provider/injection needed. Usage:
//   Toast.success('הועתק')
//   Toast.error(err.message)
//   Toast.warning('...', 6000, () => doSomething()) // click action

const defaultTimeout = 4000

let nextId = 0

export const toastState = reactive({ toasts: [] })

function createToast(text, status, action) {
  return { text, status, id: ++nextId, action: typeof action === 'function' ? action : null }
}

function push(text, status, timeout, action) {
  const toast = createToast(text, status, action)
  toastState.toasts.push(toast)
  // timeout = 0 keeps the toast until clicked
  if (timeout !== 0) setTimeout(() => closeToast(toast), timeout || defaultTimeout)
  return toast
}

function closeToast(toast) {
  const index = toastState.toasts.findIndex(item => item.id === toast.id)
  if (index !== -1) toastState.toasts.splice(index, 1)
}

export const Toast = {
  state: toastState,
  close: closeToast,
  click(toast) {
    if (toast.action) toast.action()
    closeToast(toast)
  },
  success(text, timeout, action) {
    return push(text, 'success', timeout, action)
  },
  warning(text, timeout, action) {
    return push(text, 'warning', timeout, action)
  },
  error(text, timeout, action) {
    console.error(text)
    return push(text, 'error', timeout, action)
  }
}

export default Toast
