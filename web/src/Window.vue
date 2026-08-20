<script setup>
import { onMounted, onUnmounted, ref } from 'vue'

const props = defineProps({
  title: { type: String, default: '' },
  storageKey: { type: String, required: true },
  minW: { type: Number, default: 300 },
  minH: { type: Number, default: 240 },
  defaultW: { type: Number, default: 380 },
  defaultH: { type: Number, default: 460 },
  // Where to place the window by default if nothing is saved.
  defaultRight: { type: Number, default: 40 } // px from the right edge
})
const emit = defineEmits(['close'])

// -------- Window state (drag / resize, persisted) --------

function loadWindow() {
  try {
    const value = JSON.parse(localStorage.getItem(props.storageKey) || 'null')
    if (value && typeof value === 'object') return value
  } catch {}
  return null
}

const saved = loadWindow()
const winLeft = ref(saved?.left ?? Math.max(12, window.innerWidth - props.defaultW - props.defaultRight))
const winTop = ref(saved?.top ?? Math.max(12, window.innerHeight - props.defaultH - 40))
const winWidth = ref(saved?.width ?? props.defaultW)
const winHeight = ref(saved?.height ?? props.defaultH)

function saveWindow() {
  try {
    localStorage.setItem(props.storageKey, JSON.stringify({
      left: winLeft.value, top: winTop.value, width: winWidth.value, height: winHeight.value
    }))
  } catch {}
}

function clampWindow() {
  const maxLeft = Math.max(0, window.innerWidth - 80)
  const maxTop = Math.max(0, window.innerHeight - 60)
  winLeft.value = Math.min(Math.max(0, winLeft.value), maxLeft)
  winTop.value = Math.min(Math.max(0, winTop.value), maxTop)
  winWidth.value = Math.min(Math.max(props.minW, winWidth.value), window.innerWidth)
  winHeight.value = Math.min(Math.max(props.minH, winHeight.value), window.innerHeight)
}

function startDrag(event) {
  if (event.button !== 0) return
  const startX = event.clientX
  const startY = event.clientY
  const originLeft = winLeft.value
  const originTop = winTop.value
  const onMove = (e) => {
    winLeft.value = Math.min(Math.max(0, originLeft + e.clientX - startX), window.innerWidth - 60)
    winTop.value = Math.min(Math.max(0, originTop + e.clientY - startY), window.innerHeight - 40)
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    saveWindow()
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

function startResize(event) {
  if (event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  const startX = event.clientX
  const startY = event.clientY
  const originW = winWidth.value
  const originH = winHeight.value
  const onMove = (e) => {
    winWidth.value = Math.max(props.minW, Math.min(window.innerWidth - winLeft.value, originW + e.clientX - startX))
    winHeight.value = Math.max(props.minH, Math.min(window.innerHeight - winTop.value, originH + e.clientY - startY))
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    saveWindow()
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

onMounted(() => {
  clampWindow()
  window.addEventListener('resize', clampWindow)
})

onUnmounted(() => {
  window.removeEventListener('resize', clampWindow)
})
</script>

<template>
  <div
    class="search-popup generic-window"
    :style="{ left: winLeft + 'px', top: winTop + 'px', width: winWidth + 'px', height: winHeight + 'px' }"
  >
    <header class="search-popup-header" @mousedown="startDrag">
      <span class="search-popup-grip" aria-hidden="true">⠿</span>
      <!-- Optional back slot (e.g. a "‹" button before the title) -->
      <slot name="back" />
      <strong class="search-popup-title" :title="title">{{ title }}</strong>
      <slot name="header-right" />
      <button type="button" class="search-popup-close" title="סגור" @mousedown.stop @click="emit('close')">×</button>
    </header>

    <div class="window-body">
      <slot />
    </div>

    <span class="search-popup-resize" @mousedown="startResize" aria-hidden="true"></span>
  </div>
</template>