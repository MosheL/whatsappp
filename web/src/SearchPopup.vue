<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { formatTime, formatDateFull, formatDateCaption } from './helpers.js'
import Window from './Window.vue'
import {
  mediaUrl as renderMediaUrl,
  mediaLabel,
  mediaKind,
  mediaKindFromMime,
  isDownloadableMedia,
  loadedMediaUrl as renderLoadedMediaUrl,
  mediaFileName,
  mediaPreviewStyle,
  mediaSizeStyle,
  hasMediaPreview,
  mediaActionLabel,
  senderNumberLabel,
  isCallMessage,
  isContactMessage,
  contactDisplayName,
  contactPhone,
  isForwardedMessage,
  isInteractiveMessage,
  isLocationMessage,
  interactiveTypeLabel,
  isUnsupportedMessage,
  formatMessageText
} from './message-renderer.js'

const props = defineProps({
  selectedBot: { type: String, default: '' },
  currentChat: { type: String, default: '' }
})
const emit = defineEmits(['close'])

// -------- API helper --------

function api(path, options = {}) {
  return fetch(path, options).then(async response => {
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(data.error || 'שגיאה')
      error.status = response.status
      throw error
    }
    return data
  })
}

// -------- Search view --------

const query = ref('')
const scope = ref('all') // 'all' | 'current'
const results = ref([])
const searching = ref(false)
const searchError = ref('')
const truncated = ref(false)
let searchTimer
let searchRequest = 0

const PAGE_SIZE = 50
const canSearchCurrent = computed(() => Boolean(props.currentChat))
const hasQuery = computed(() => query.value.trim().length >= 2)

function runSearch() {
  const term = query.value.trim()
  searchRequest += 1
  const requestId = searchRequest
  if (term.length < 2) {
    results.value = []
    searching.value = false
    searchError.value = ''
    truncated.value = false
    return
  }
  searching.value = true
  searchError.value = ''
  const params = new URLSearchParams({ bot: props.selectedBot, q: term, limit: String(PAGE_SIZE) })
  if (scope.value === 'current' && props.currentChat) params.set('chat', props.currentChat)
  api(`/api/search?${params}`)
    .then(data => {
      if (requestId !== searchRequest) return
      results.value = data.results || []
      truncated.value = Boolean(data.truncated)
    })
    .catch(err => {
      if (requestId !== searchRequest) return
      results.value = []
      searchError.value = err.message
    })
    .finally(() => {
      if (requestId === searchRequest) searching.value = false
    })
}

watch(query, () => {
  clearTimeout(searchTimer)
  searchRequest += 1
  searching.value = false
  searchTimer = setTimeout(runSearch, 350)
})

watch(scope, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(runSearch, 150)
})

// If the current chat closes while searching within it, fall back to all chats.
watch(() => props.currentChat, (jid) => {
  if (!jid && scope.value === 'current') {
    scope.value = 'all'
    runSearch()
  }
})

watch(() => props.selectedBot, () => {
  // Reset everything when the bot changes.
  query.value = ''
  results.value = []
  context.value = null
})

// Build a snippet around the first match with <mark> highlighting.
function snippet(text, term) {
  if (!text) return []
  const lower = text.toLowerCase()
  const idx = lower.indexOf(term.toLowerCase())
  if (idx < 0) return [{ type: 'text', text }]
  const radius = 80
  const start = Math.max(0, idx - radius)
  const end = Math.min(text.length, idx + term.length + radius)
  const parts = []
  if (start > 0) parts.push({ type: 'text', text: (start > 0 ? '…' : '') })
  if (start < idx) parts.push({ type: 'text', text: text.slice(start, idx) })
  parts.push({ type: 'mark', text: text.slice(idx, idx + term.length) })
  if (end > idx + term.length) parts.push({ type: 'text', text: text.slice(idx + term.length, end) })
  if (end < text.length) parts.push({ type: 'text', text: '…' })
  return parts
}

// -------- Context view --------

const context = ref(null) // { jid, id, chatName, messages, hasOlder, hasNewer }
const contextLoading = ref(false)
const contextError = ref('')
const contextScrollRef = ref(null)
let contextRequest = 0
const matchId = ref('') // the message we jumped to — to highlight
const loadedMedia = ref({})
const loadingMedia = ref({})
const replyTo = ref(null)
const replyText = ref('')
const replyRef = ref(null)
const sendingReply = ref(false)
const loadingOlderCtx = ref(false)
const loadingNewerCtx = ref(false)

async function openContext(result) {
  const jid = result.jid
  const id = result.id
  const bot = props.selectedBot
  const requestId = ++contextRequest
  context.value = { jid, id, chatName: result.chatName || '', messages: [], hasOlder: false, hasNewer: false }
  matchId.value = id
  contextLoading.value = true
  contextError.value = ''
  loadedMedia.value = {}
  loadingMedia.value = {}
  replyTo.value = null
  replyText.value = ''
  try {
    const params = new URLSearchParams({ bot, jid, id, limit: '40' })
    const data = await api(`/api/messages-around?${params}`)
    if (requestId !== contextRequest) return
    context.value = {
      jid, id,
      chatName: result.chatName || '',
      messages: data.messages || [],
      hasOlder: Boolean(data.hasOlder),
      hasNewer: Boolean(data.hasNewer)
    }
    await nextTick()
    scrollToMatch(id)
  } catch (err) {
    if (requestId !== contextRequest) return
    contextError.value = err.message
  } finally {
    if (requestId === contextRequest) contextLoading.value = false
  }
}

function closeContext() {
  context.value = null
  matchId.value = ''
  for (const url of Object.values(loadedMedia.value)) {
    if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url)
  }
  loadedMedia.value = {}
  loadingMedia.value = {}
  replyTo.value = null
  replyText.value = ''
}

function scrollToMatch(id) {
  const el = contextScrollRef.value?.querySelector(`[data-message-id="${id}"]`)
  if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function showDateCaption(index) {
  const messages = context.value?.messages || []
  if (index === 0) return true
  const prev = messages[index - 1]
  const curr = messages[index]
  if (!prev || !curr) return false
  return new Date(prev.timestamp).toDateString() !== new Date(curr.timestamp).toDateString()
}

function messageUrl(message) {
  return renderMediaUrl(message, props.selectedBot)
}

function loadedMediaUrl(message) {
  return renderLoadedMediaUrl(message, loadedMedia.value)
}

async function loadMedia(message) {
  if (!message?.id || !isDownloadableMedia(message) || loadedMedia.value[message.id]) return
  loadingMedia.value = { ...loadingMedia.value, [message.id]: true }
  try {
    const response = await fetch(messageUrl(message))
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error || 'אין אפשרות לטעון מדיה')
    }
    const blob = await response.blob()
    const kind = mediaKind(message) || mediaKindFromMime(blob.type)
    if (kind && kind !== mediaKind(message)) {
      // Update local copy so subsequent renders use the resolved kind.
      const messages = context.value?.messages.map(item => item.id === message.id
        ? { ...item, media: { ...(item.media || {}), kind, mimetype: blob.type, caption: item.media?.caption || '', url: '' }, viewOnceType: item.viewOnceType || kind }
        : item)
      if (context.value) context.value = { ...context.value, messages }
    }
    const prev = loadedMedia.value[message.id]
    if (typeof prev === 'string' && prev.startsWith('blob:')) URL.revokeObjectURL(prev)
    loadedMedia.value = { ...loadedMedia.value, [message.id]: URL.createObjectURL(blob) }
  } catch {
    // ignore — leave the load button in place
  } finally {
    const next = { ...loadingMedia.value }
    delete next[message.id]
    loadingMedia.value = next
  }
}

function beginBubbleDrag(event, message) {
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData('application/x-whatsapp-forward', JSON.stringify({
    bot: props.selectedBot,
    jid: message.jid || context.value?.jid,
    id: message.id,
    fileName: mediaFileName(message),
    mimeType: message.media?.mimetype || '',
    text: message.text || ''
  }))
  event.dataTransfer.setData('text/plain', message.text || mediaFileName(message) || 'הודעה')
}

function startReply(message) {
  replyTo.value = message
  nextTick(() => replyRef.value?.focus())
}

function cancelReply() {
  replyTo.value = null
  replyText.value = ''
}

async function sendReply() {
  const target = replyTo.value
  const jid = context.value?.jid
  const bot = props.selectedBot
  if (!target || !jid || !replyText.value.trim() || sendingReply.value) return
  const text = replyText.value.trim()
  sendingReply.value = true
  try {
    const data = await api('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot, jid, text, quotedId: target.id, quotedJid: target.jid || jid })
    })
    if (data.message && context.value?.jid === jid) {
      const messages = context.value.messages
      const exists = messages.some(message => message.id === data.message.id)
      context.value = {
        ...context.value,
        messages: exists
          ? messages.map(message => message.id === data.message.id ? { ...message, ...data.message } : message)
          : [...messages, data.message].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      }
      await nextTick()
      if (contextScrollRef.value) contextScrollRef.value.scrollTo({ top: contextScrollRef.value.scrollHeight, behavior: 'smooth' })
    }
    replyTo.value = null
    replyText.value = ''
  } catch (err) {
    contextError.value = err.message
  } finally {
    sendingReply.value = false
  }
}

function onReplyKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendReply()
  }
}

async function loadOlderContext() {
  const ctx = context.value
  if (!ctx || loadingOlderCtx.value) return
  const oldest = ctx.messages[0]
  if (!oldest) return
  const bot = props.selectedBot
  const requestId = contextRequest
  loadingOlderCtx.value = true
  try {
    const params = new URLSearchParams({ bot, jid: ctx.jid, before: String(oldest.timestamp), limit: '20' })
    const data = await api(`/api/messages?${params}`)
    if (requestId !== contextRequest) return
    const known = new Set(ctx.messages.map(message => message.id))
    const fresh = (data.messages || []).filter(message => !known.has(message.id))
    context.value = {
      ...ctx,
      messages: [...fresh, ...ctx.messages],
      hasOlder: fresh.length >= 20
    }
    const prevHeight = contextScrollRef.value?.scrollHeight || 0
    await nextTick()
    if (contextScrollRef.value) contextScrollRef.value.scrollTop += (contextScrollRef.value.scrollHeight - prevHeight)
  } catch (err) {
    contextError.value = err.message
  } finally {
    if (requestId === contextRequest) loadingOlderCtx.value = false
  }
}

async function loadNewerContext() {
  const ctx = context.value
  if (!ctx || loadingNewerCtx.value) return
  const newest = ctx.messages[ctx.messages.length - 1]
  if (!newest) return
  const bot = props.selectedBot
  const requestId = contextRequest
  loadingNewerCtx.value = true
  try {
    const params = new URLSearchParams({ bot, jid: ctx.jid, after: String(newest.timestamp), limit: '20' })
    const data = await api(`/api/messages?${params}`)
    if (requestId !== contextRequest) return
    const known = new Set(ctx.messages.map(message => message.id))
    const fresh = (data.messages || []).filter(message => !known.has(message.id))
    context.value = {
      ...ctx,
      messages: [...ctx.messages, ...fresh],
      hasNewer: fresh.length >= 20
    }
    await nextTick()
  } catch (err) {
    contextError.value = err.message
  } finally {
    if (requestId === contextRequest) loadingNewerCtx.value = false
  }
}

onUnmounted(() => {
  clearTimeout(searchTimer)
  for (const url of Object.values(loadedMedia.value)) {
    if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url)
  }
})

function senderName(message) {
  if (!message) return ''
  return message.fromMe ? 'אני' : message.sender
}
</script>

<template>
  <Window
    storage-key="wa-ui-search-window"
    :title="context ? (context.chatName || 'הקשר') : 'חיפוש בהודעות'"
    :default-w="440"
    :default-h="520"
    :default-right="20"
    @close="emit('close')"
  >
    <template #back>
      <button
        v-if="context"
        type="button"
        class="search-popup-back"
        title="חזרה לתוצאות"
        @mousedown.stop
        @click="closeContext"
      >‹</button>
    </template>

    <!-- Search results view -->
    <section v-if="!context" class="search-popup-body">
      <div class="search-popup-input-row">
        <input
          v-model="query"
          type="search"
          placeholder="חיפוש בתוכן ההודעות…"
          class="search-popup-input"
          autofocus
        />
        <span v-if="searching" class="search-popup-spinner" aria-hidden="true"></span>
      </div>
      <div class="search-popup-scope" role="tablist" aria-label="היקף חיפוש">
        <button type="button" role="tab" :aria-selected="scope === 'all'" :class="{ active: scope === 'all' }" @click="scope = 'all'">כל השיחות</button>
        <button type="button" role="tab" :aria-selected="scope === 'current'" :class="{ active: scope === 'current' }" :disabled="!canSearchCurrent" :title="canSearchCurrent ? '' : 'אין שיחה פתוחה'" @click="canSearchCurrent && (scope = 'current')">שיחה נוכחית</button>
      </div>
      <p v-if="searchError" class="search-popup-error">{{ searchError }}</p>
      <p v-else-if="hasQuery && !searching && !results.length" class="search-popup-empty">לא נמצאו הודעות</p>
      <p v-else-if="!hasQuery" class="search-popup-hint">{{ scope === 'current' ? 'חפש בשיחה הנוכחית — הקלד שני תווים לפחות' : 'חפש בכל ההודעות השמורות — הקלד שני תווים לפחות' }}</p>
      <p v-if="truncated && results.length" class="search-popup-truncated">ייתכן שיש תוצאות נוספות — צמצם את החיפוש</p>
      <div class="search-popup-results">
        <button
          v-for="result in results"
          :key="result.id"
          type="button"
          class="search-popup-result"
          @click="openContext(result)"
        >
          <span class="search-popup-result-head">
            <strong dir="auto">{{ result.chatName || result.displayJid || result.jid }}</strong>
            <small>{{ formatTime(result.timestamp) }}</small>
          </span>
          <span class="search-popup-result-sender" dir="auto">
            {{ result.fromMe ? 'אני' : (result.sender || '') }}<template v-if="result.isGroup"> · קבוצה</template>
          </span>
          <span class="search-popup-result-text" dir="auto">
            <template v-for="(part, index) in snippet(result.text, query.trim())" :key="index">
              <mark v-if="part.type === 'mark'">{{ part.text }}</mark>
              <span v-else>{{ part.text }}</span>
            </template>
          </span>
        </button>
      </div>
    </section>

    <!-- Context view -->
    <section v-else class="search-popup-context">
      <p v-if="contextError" class="search-popup-error">{{ contextError }}</p>
      <div ref="contextScrollRef" class="search-popup-context-scroll">
        <button
          v-if="context.hasOlder && !loadingOlderCtx"
          type="button"
          class="search-popup-more"
          @click="loadOlderContext"
        >טען ישן יותר</button>
        <span v-else-if="loadingOlderCtx" class="search-popup-more-loading">טוען…</span>
        <div v-if="contextLoading" class="search-popup-loading">
          <span class="search-popup-spinner" aria-hidden="true"></span>
          <span>טוען הקשר…</span>
        </div>
        <template v-else>
          <template v-for="(message, index) in context.messages" :key="message.id">
            <div v-if="showDateCaption(index)" class="search-popup-date-caption">{{ formatDateCaption(message.timestamp) }}</div>
            <div
              :data-message-id="message.id"
              :class="['search-popup-message', { mine: message.fromMe, match: message.id === matchId }]"
            >
              <span
                class="search-popup-drag-handle"
                draggable="true"
                title="גרור להעברה"
                @dragstart.stop="beginBubbleDrag($event, message)"
              >⠿</span>
              <article class="search-popup-bubble">
                <div v-if="isForwardedMessage(message)" class="search-popup-forwarded">הועברה</div>
                <strong v-if="!message.fromMe" class="search-popup-sender">
                  {{ message.sender }}
                  <small v-if="senderNumberLabel(message)">{{ senderNumberLabel(message) }}</small>
                </strong>
                <div
                  v-if="isDownloadableMedia(message)"
                  class="search-popup-media"
                >
                  <button
                    v-if="mediaKind(message) !== 'document' && !loadedMediaUrl(message)"
                    :class="['search-popup-media-button', { preview: hasMediaPreview(message) }]"
                    :style="mediaPreviewStyle(message)"
                    type="button"
                    :disabled="loadingMedia[message.id]"
                    @click="loadMedia(message)"
                  >
                    {{ loadingMedia[message.id] ? 'טוען...' : mediaActionLabel(message) }}
                  </button>
                  <a
                    v-else-if="mediaKind(message) === 'document'"
                    class="search-popup-media-button"
                    :href="messageUrl(message)"
                    :download="mediaFileName(message)"
                    target="_blank"
                    rel="noreferrer"
                  >הורד {{ mediaFileName(message) }}</a>
                  <img
                    v-else-if="mediaKind(message) === 'image' || mediaKind(message) === 'sticker'"
                    :class="['search-popup-image', { sticker: mediaKind(message) === 'sticker' }]"
                    :src="loadedMediaUrl(message)"
                    alt=""
                  />
                  <div
                    v-else-if="mediaKind(message) === 'video'"
                    class="search-popup-video-wrap"
                    :style="mediaSizeStyle(message)"
                  >
                    <video class="search-popup-video" :src="loadedMediaUrl(message)" :style="mediaSizeStyle(message)" controls preload="metadata"></video>
                  </div>
                  <audio v-else class="search-popup-audio" :src="loadedMediaUrl(message)" controls preload="metadata"></audio>
                </div>
                <div v-else-if="isContactMessage(message)" class="search-popup-special">
                  <span aria-hidden="true">👤</span>
                  <strong dir="auto">{{ contactDisplayName(message) }}</strong>
                  <small v-if="contactPhone(message)" dir="ltr">{{ contactPhone(message) }}</small>
                </div>
                <div v-else-if="isLocationMessage(message) && message.location" class="search-popup-special">
                  <span aria-hidden="true">📍</span>
                  <span dir="auto">{{ message.location.name || message.location.address || 'מיקום' }}</span>
                </div>
                <div v-else-if="isCallMessage(message)" class="search-popup-special">
                  <span aria-hidden="true">{{ message.call?.isVideo ? 'וידאו' : 'קול' }}</span>
                  <strong dir="auto">{{ message.text }}</strong>
                </div>
                <div v-else-if="isInteractiveMessage(message) && message.interactiveData" class="search-popup-special">
                  <strong dir="auto">{{ message.interactiveData.title || message.interactiveData.body || interactiveTypeLabel(message) }}</strong>
                </div>
                <div v-else-if="isUnsupportedMessage(message)" class="search-popup-special">
                  <span aria-hidden="true">⚠️</span>
                  <span>הודעה לא נתמכת</span>
                  <small v-if="message.type" dir="ltr">{{ message.type }}</small>
                </div>
                <p v-else class="search-popup-text" dir="auto">
                  <template v-for="(part, index) in formatMessageText(message.text || message.type)" :key="`${message.id}:${index}`">
                    <a v-if="part.type === 'link'" :class="{ bold: part.bold, strike: part.strike }" :href="part.href" target="_blank" rel="noreferrer">{{ part.text }}</a>
                    <a v-else-if="part.type === 'email'" :class="{ bold: part.bold, strike: part.strike }" :href="part.href" target="_blank" rel="noreferrer">{{ part.text }}</a>
                    <strong v-else-if="part.bold && !part.strike">{{ part.text }}</strong>
                    <strong v-else-if="part.bold && part.strike"><del>{{ part.text }}</del></strong>
                    <del v-else-if="part.strike">{{ part.text }}</del>
                    <span v-else>{{ part.text }}</span>
                  </template>
                </p>
                <small v-if="message.edited" class="search-popup-edited">נערך</small>
                <small v-if="message.deleted" class="search-popup-deleted">הודעה נמחקה</small>
                <span class="search-popup-meta">
                  <time :title="formatDateFull(message.timestamp)">{{ formatTime(message.timestamp) }}</time>
                </span>
              </article>
              <button
                type="button"
                class="search-popup-reply-btn"
                title="השב"
                @click="startReply(message)"
              >↩</button>
            </div>
          </template>
        </template>
        <button
          v-if="context.hasNewer && !loadingNewerCtx"
          type="button"
          class="search-popup-more"
          @click="loadNewerContext"
        >טען חדש יותר</button>
        <span v-else-if="loadingNewerCtx" class="search-popup-more-loading">טוען…</span>
      </div>
      <footer v-if="replyTo" class="search-popup-reply">
        <div class="search-popup-reply-strip">
          <div>
            <strong>משיב ל{{ senderName(replyTo) }}</strong>
            <span dir="auto">{{ replyTo.text || mediaLabel(replyTo) }}</span>
          </div>
          <button type="button" title="בטל תגובה" @click="cancelReply">×</button>
        </div>
        <div class="search-popup-reply-form">
          <textarea
            ref="replyRef"
            v-model="replyText"
            rows="1"
            placeholder="הודעת תגובה"
            @keydown="onReplyKeydown"
          ></textarea>
          <button type="button" :disabled="!replyText.trim() || sendingReply" @click="sendReply">{{ sendingReply ? '...' : 'שלח' }}</button>
        </div>
      </footer>
    </section>
  </Window>
</template>
