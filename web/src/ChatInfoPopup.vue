<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { initials, avatarUrl } from './helpers.js'

const props = defineProps({
  selectedBot: { type: String, default: '' },
  chat: { type: Object, default: null },
  participants: { type: Array, default: () => [] }
})
const emit = defineEmits(['close', 'leave-group', 'refresh-participants'])

// -------- Window state (drag / resize, persisted) --------

const STORAGE_KEY = 'wa-ui-chatinfo-window'
const MIN_W = 300
const MIN_H = 240

function loadWindow() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (value && typeof value === 'object') return value
  } catch {}
  return null
}

const saved = loadWindow()
const winLeft = ref(saved?.left ?? Math.max(12, window.innerWidth - 420))
const winTop = ref(saved?.top ?? Math.max(12, window.innerHeight - 480))
const winWidth = ref(saved?.width ?? 380)
const winHeight = ref(saved?.height ?? 460)
const windowRef = ref(null)

function saveWindow() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      left: winLeft.value, top: winTop.value, width: winWidth.value, height: winHeight.value
    }))
  } catch {}
}

function clampWindow() {
  const maxLeft = Math.max(0, window.innerWidth - 80)
  const maxTop = Math.max(0, window.innerHeight - 60)
  winLeft.value = Math.min(Math.max(0, winLeft.value), maxLeft)
  winTop.value = Math.min(Math.max(0, winTop.value), maxTop)
  winWidth.value = Math.min(Math.max(MIN_W, winWidth.value), window.innerWidth)
  winHeight.value = Math.min(Math.max(MIN_H, winHeight.value), window.innerHeight)
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
    winWidth.value = Math.max(MIN_W, Math.min(window.innerWidth - winLeft.value, originW + e.clientX - startX))
    winHeight.value = Math.max(MIN_H, Math.min(window.innerHeight - winTop.value, originH + e.clientY - startY))
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    saveWindow()
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// -------- Group info / actions --------

const isGroup = ref(false)
const description = ref('')
const infoLoading = ref(false)
const addPhone = ref('')
const adding = ref(false)
const actionError = ref('')
const avatarFailed = ref(false)

function avatarSrc() {
  return avatarFailed.value ? '' : avatarUrl(props.chat, props.selectedBot)
}
function openOriginalAvatar() {
  const url = avatarSrc()
  if (!url) return
  window.open(url, '_blank', 'noopener')
}
function onAvatarError() {
  avatarFailed.value = true
}

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: options.headers || {}
  }).then(async response => {
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(data.error || 'שגיאה')
      error.status = response.status
      throw error
    }
    return data
  })
}

async function loadDescription() {
  if (!isGroup.value || !props.chat?.jid) return
  infoLoading.value = true
  try {
    const params = new URLSearchParams({ bot: props.selectedBot, jid: props.chat.jid })
    const data = await api(`/api/group-participants?${params}`)
    description.value = data.info?.description || ''
  } catch {}
  finally {
    infoLoading.value = false
  }
}

async function addUser() {
  if (adding.value || !props.chat?.jid || !addPhone.value.trim()) return
  adding.value = true
  actionError.value = ''
  try {
    await api('/api/group-add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: props.selectedBot, jid: props.chat.jid, phone: addPhone.value.trim() })
    })
    addPhone.value = ''
    emit('refresh-participants')
  } catch (err) {
    actionError.value = err.message
  } finally {
    adding.value = false
  }
}

function onLeaveGroup() {
  if (!confirm('לעזוב את הקבוצה?')) return
  emit('leave-group')
}

watch(() => props.chat, (chat) => {
  isGroup.value = Boolean(chat?.isGroup)
  description.value = ''
  addPhone.value = ''
  actionError.value = ''
  avatarFailed.value = false
  if (isGroup.value) loadDescription()
}, { immediate: true })

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
    ref="windowRef"
    class="search-popup chat-info-popup"
    :style="{ left: winLeft + 'px', top: winTop + 'px', width: winWidth + 'px', height: winHeight + 'px' }"
  >
    <header class="search-popup-header" @mousedown="startDrag">
      <span class="search-popup-grip" aria-hidden="true">⠿</span>
      <strong class="search-popup-title">פרטי שיחה</strong>
      <button type="button" class="search-popup-close" title="סגור" @mousedown.stop @click="emit('close')">×</button>
    </header>

    <section class="chat-info-body">
      <div class="chat-info-hero">
        <img
          v-if="avatarSrc()"
          :src="avatarSrc()"
          alt=""
          class="chat-info-avatar image"
          title="הצג בגודל מלא"
          @click="openOriginalAvatar"
          @error="onAvatarError"
        />
        <span
          v-else
          class="chat-info-avatar"
          title="הצג בגודל מלא"
          @click="openOriginalAvatar()"
        >{{ chat?.name ? initials(chat) : (chat?.jid || '?').slice(0, 2) }}</span>
        <div class="chat-info-identity">
          <strong class="chat-info-name" dir="auto">{{ chat?.name || chat?.jid || '' }}</strong>
          <span v-if="chat?.phoneNumber" class="chat-info-phone" dir="ltr">{{ chat.phoneNumber }}</span>
          <span v-else-if="isGroup" class="chat-info-phone">קבוצה</span>
        </div>
      </div>

      <!-- Group description -->
      <div v-if="isGroup" class="chat-info-desc">
        <span class="chat-info-desc-label">תיאור</span>
        <p v-if="infoLoading" class="chat-info-empty">טוען…</p>
        <p v-else-if="description" class="chat-info-desc-text" dir="auto">{{ description }}</p>
        <p v-else class="chat-info-empty">אין תיאור קבוצה</p>
      </div>

      <!-- Add member -->
      <div v-if="isGroup" class="chat-info-add-row">
        <input
          v-model="addPhone"
          type="tel"
          placeholder="מספר טלפון להוספה"
          class="chat-info-add-input"
          @keydown.enter="addUser"
        />
        <button type="button" class="chat-info-action-btn" @click="addUser" :disabled="adding || !addPhone.trim()">
          {{ adding ? 'מוסיף…' : '➕ הוסף' }}
        </button>
      </div>
      <p v-if="actionError" class="chat-info-error">{{ actionError }}</p>

      <template v-if="isGroup">
        <div class="chat-info-section-title">
          משתמשים <span class="chat-info-count">{{ participants.length }}</span>
        </div>
        <div class="chat-info-participants">
          <p v-if="!participants.length" class="chat-info-empty">אין משתמשים</p>
          <div
            v-for="participant in participants"
            :key="participant.jid || participant.phoneNumber"
            class="chat-info-participant"
          >
            <span class="chat-info-participant-avatar">{{ initials(participant) }}</span>
            <div class="chat-info-participant-copy">
              <strong dir="auto">
                {{ participant.name || participant.phoneNumber || participant.jid }}
                <em v-if="participant.admin" class="chat-info-admin" title="מנהל/בעלים">👑</em>
              </strong>
              <small v-if="participant.phoneNumber" dir="ltr">{{ participant.phoneNumber }}</small>
            </div>
          </div>
        </div>
      </template>
    </section>

    <footer v-if="isGroup" class="chat-info-footer">
      <button type="button" class="chat-info-leave" @click="onLeaveGroup">
        🙋 עזוב את הקבוצה
      </button>
    </footer>

    <span class="search-popup-resize" @mousedown="startResize" aria-hidden="true"></span>
  </div>
</template>