import { onUnmounted, ref } from 'vue'

export function useBlob() {
  const url = ref('')

  function clearBlob() {
    if (url.value) URL.revokeObjectURL(url.value)
    url.value = ''
  }

  function setBlob(blob) {
    clearBlob()
    if (blob) url.value = URL.createObjectURL(blob)
    return url.value
  }

  onUnmounted(clearBlob)

  return { url, setBlob, clearBlob }
}
