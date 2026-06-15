<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { formatTime, formatDateFull, formatDateCaption } from './helpers.js'
import {
  mediaUrl as renderMediaUrl,
  mediaLabel, mediaKind, isDownloadableMedia,
  loadedMediaUrl as renderLoadedMediaUrl,
  mediaFileName, mediaPreviewStyle, mediaSizeStyle, hasMediaPreview,
  mediaActionLabel, senderNumberLabel, isCallMessage,
  isContactMessage, contactDisplayName, contactPhone, hasMultipleContacts, contactEntryPhone,
  shouldShowMessageStatus, isMyReaction, messageReactions,
  reactionUserKey, formatMessageText,
  mediaKindFromMime, isForwardedMessage, linkPreviewHref, linkPreviewHost, linkPreviewImageStyle,
  isInteractiveMessage, interactiveTypeLabel
} from './message-renderer.js'
import StatusTick from './StatusTick.vue'

// Track typing clear timers per chat JID
const typingTimers = new Map()
const threadEl = ref(null)
const textSelected = ref(false)

function clearTypingAfterDelay(jid, typingTimestamp) {
  const existing = typingTimers.get(jid)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    typingTimers.delete(jid)
    emit('typing-expired', jid, typingTimestamp)
  }, 10000)
  typingTimers.set(jid, timer)
}

function onSelectionChange() {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    textSelected.value = false
    return
  }
  const range = sel.getRangeAt(0)
  const thread = threadEl.value
  if (!thread) {
    textSelected.value = false
    return
  }
  const ancestor = range.commonAncestorContainer
  const el = ancestor.nodeType === 1 ? ancestor : ancestor.parentElement
  textSelected.value = thread.contains(ancestor) && !el?.closest('.message-menu-button, .message-menu, .message-reaction-picker')
}

onMounted(() => {
  document.addEventListener('selectionchange', onSelectionChange)
})

onUnmounted(() => {
  for (const timer of typingTimers.values()) clearTimeout(timer)
  typingTimers.clear()
  for (const url of Object.values(loadedMedia.value)) {
    if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url)
  }
})

watch(textSelected, () => {
  // Close menu if text is selected
  if (textSelected.value) {
    menuPosition.value = null
  }
})

const props = defineProps({
  messages: { type: Array, default: () => [] },
  selectedChat: { type: String, default: '' },
  currentChat: { type: Object, default: null },
  loadingMessages: { type: Boolean, default: false },
  loadingOlder: { type: Boolean, default: false },
  autoMarkRead: { type: Boolean, default: false },
  actionMessageId: { type: String, default: '' },
  reactionMessageId: { type: String, default: '' },
  replyTo: { type: Object, default: null },
  selectedBot: { type: String, default: '' },
  draggingFile: { type: Boolean, default: false },
  emojis: { type: Array, default: () => [] }
})

const emit = defineEmits([
  'select-chat', 'toggle-message-menu', 'reply-message',
  'toggle-reaction-menu', 'delete-message',
  'load-older', 'thread-click', 'reply-from-thread-dbclick',
  'drag-over', 'drag-drop', 'open-upload-modal', 'react',
  'scroll-to-message', 'message-update', 'typing-expired', 'error',
  'mention-click',
  'reply-private',
  'forward-message'
])

watch(() => props.currentChat?.typing, (typing, oldTyping) => {
  const jid = props.currentChat?.jid
  const typingTimestamp = props.currentChat?.typingTimestamp
  if (!jid) return
  if (typing) {
    // Only restart timer when the typing person actually changes, not on timestamp refresh
    if (typing !== oldTyping && typingTimestamp) {
      clearTypingAfterDelay(jid, typingTimestamp)
    }
  } else {
    // Typing stopped — clear the timer
    const existing = typingTimers.get(jid)
    if (existing) clearTimeout(existing)
    typingTimers.delete(jid)
  }
})

function showDateCaption(index) {
  if (index === 0) return true
  const prev = props.messages[index - 1]
  const curr = props.messages[index]
  if (!prev || !curr) return false
  const prevDate = new Date(prev.timestamp)
  const currDate = new Date(curr.timestamp)
  return prevDate.toDateString() !== currDate.toDateString()
}

function dateCaption(index) {
  const msg = props.messages[index]
  if (!msg) return ''
  return formatDateCaption(msg.timestamp)
}

function mediaUrl(message) {
  return renderMediaUrl(message, props.selectedBot)
}

const loadedMedia = ref({})
const loadingMedia = ref({})

watch(() => props.selectedChat, () => {
  for (const url of Object.values(loadedMedia.value)) {
    if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url)
  }
  loadedMedia.value = {}
  loadingMedia.value = {}
})

function loadedMediaUrl(message) {
  return renderLoadedMediaUrl(message, loadedMedia.value)
}



function revokeLoadedMedia(id) {
  const url = loadedMedia.value[id]
  if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url)
}

async function loadMedia(message) {
  if (!message?.id || !isDownloadableMedia(message) || loadedMedia.value[message.id]) return
  loadingMedia.value = { ...loadingMedia.value, [message.id]: true }
  try {
    const response = await fetch(mediaUrl(message))
    if (!response.ok) {
      const data = await response.json().catch(() => ({}) )
      throw new Error(data.error || 'אין אפשרות לטעון מדיה')
    }
    const blob = await response.blob()
    const kind = mediaKind(message) || mediaKindFromMime(blob.type)
    if (kind && kind !== mediaKind(message)) {
      emit('message-update', {
        ...message,
        media: { ...(message.media || {}), kind, mimetype: blob.type, caption: message.media?.caption || '', url: '' },
        viewOnceType: message.viewOnceType || kind
      })
    }
    revokeLoadedMedia(message.id)
    loadedMedia.value = { ...loadedMedia.value, [message.id]: URL.createObjectURL(blob) }
  } catch (err) {
    emit('error', err?.message || 'אין אפשרות לטעון מדיה')
  } finally {
    finishMediaLoad(message)
  }
}

function finishMediaLoad(message) {
  if (!message?.id || !loadingMedia.value[message.id]) return
  const next = { ...loadingMedia.value }
  delete next[message.id]
  loadingMedia.value = next
}

function beginMediaDrag(event, message) {
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData('application/x-whatsapp-media', JSON.stringify({
    bot: props.selectedBot,
    jid: message.jid || props.selectedChat,
    id: message.id,
    fileName: mediaFileName(message),
    mimeType: message.media?.mimetype || ''
  }))
  event.dataTransfer.setData('text/plain', mediaFileName(message))
}

function handleDoubleClick(event, messages) {
  if (!props.selectedChat || props.loadingMessages) return
  if (event.target.closest?.('button, a, input, textarea, select, video')) return
  const bubble = event.target.closest?.('.bubble')
  if (!bubble) return
  const messageId = bubble.dataset?.messageId
  if (!messageId) return
  const message = messages.find(m => m.id === messageId)
  if (message) emit('reply-from-thread-dbclick', message)
}

function handleContextMenu(event, messages) {
  if (!props.selectedChat || props.loadingMessages) return
  event.preventDefault()
  const bubble = event.target.closest?.('.bubble')
  if (!bubble) return
  const messageId = bubble.dataset?.messageId
  if (!messageId) return
  const message = messages.find(m => m.id === messageId)
  if (message) {
    updateMenuPosition(event.currentTarget || bubble)
    emit('toggle-message-menu', message)
  }
}

function beginBubbleDrag(event, message) {
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData('application/x-whatsapp-forward', JSON.stringify({
    bot: props.selectedBot,
    jid: message.jid || props.selectedChat,
    id: message.id,
    fileName: mediaFileName(message),
    mimeType: message.media?.mimetype || '',
    text: message.text || ''
  }))
  event.dataTransfer.setData('text/plain', message.text || mediaFileName(message) || 'הודעה')
  event.target.setAttribute('dragging', '')
}

// Copy message text with 'אני:' prefix for fromMe messages
function copyWithPrefix(message) {
  const prefix = message.fromMe ? 'אני: ' : ''
  const text = message.text || ''
  const clipboardText = prefix + text
  if (!clipboardText) return
  navigator.clipboard.writeText(clipboardText).catch(() => {})
}

// Fallback copy for non-secure contexts (old textarea method)
function copyTextFallback(text) {
  if (!text) return
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;height:0;width:0;padding:0;border:none;outline:none'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    document.execCommand('copy')
  } catch (e) { /* ignore */ }
  document.body.removeChild(textarea)
}

function copyAllText(message) {
  const text = message.text || ''
  if (!text) return
  copyTextFallback(text)
}

const MESSAGE_WINDOW_SIZE = 80
const MESSAGE_WINDOW_STEP = 60
const MESSAGE_ESTIMATED_HEIGHT = 104
const messageWindowStart = ref(0)
const menuPosition = ref(null)
let expandingMessageWindow = false

const visibleMessages = computed(() => props.messages
  .slice(messageWindowStart.value)
  .map((message, offset) => ({ message, index: messageWindowStart.value + offset })))
const actionMessage = computed(() => props.messages.find(message => message.id === props.actionMessageId))

const messageTopSpacerHeight = computed(() => messageWindowStart.value * MESSAGE_ESTIMATED_HEIGHT)

watch(() => props.selectedChat, () => {
  messageWindowStart.value = Math.max(0, props.messages.length - MESSAGE_WINDOW_SIZE)
})

watch(() => props.messages, (messages, oldMessages) => {
  if (!oldMessages?.length || messages.length < oldMessages.length) {
    messageWindowStart.value = Math.max(0, messages.length - MESSAGE_WINDOW_SIZE)
    return
  }
  const firstVisibleId = oldMessages[messageWindowStart.value]?.id
  const firstVisibleIndex = firstVisibleId
    ? messages.findIndex(message => message.id === firstVisibleId)
    : -1
  if (firstVisibleIndex >= 0) {
    const insertedBefore = firstVisibleIndex - messageWindowStart.value
    messageWindowStart.value = firstVisibleIndex
    if (insertedBefore > 0) {
      nextTick(() => {
        if (threadEl.value) threadEl.value.scrollTop += insertedBefore * MESSAGE_ESTIMATED_HEIGHT
      })
    }
  }
}, { flush: 'sync' })

async function expandMessageWindow() {
  if (expandingMessageWindow || messageWindowStart.value === 0 || !threadEl.value) return
  expandingMessageWindow = true
  const el = threadEl.value
  const oldHeight = el.scrollHeight
  messageWindowStart.value = Math.max(0, messageWindowStart.value - MESSAGE_WINDOW_STEP)
  await nextTick()
  el.scrollTop += el.scrollHeight - oldHeight
  expandingMessageWindow = false
}

function handleThreadScroll() {
  const el = threadEl.value
  if (!el) return
  if (messageWindowStart.value > 0 && el.scrollTop <= messageTopSpacerHeight.value + el.clientHeight) expandMessageWindow()
  if (props.actionMessageId) updateMenuPosition()
}

function toggleMessageMenu(event, message) {
  updateMenuPosition(event.currentTarget)
  emit('toggle-message-menu', message)
}

function updateMenuPosition(button) {
  const target = button || threadEl.value?.querySelector(`[data-message-id="${props.actionMessageId}"] .message-menu-button`)
  if (!target) {
    menuPosition.value = null
    return
  }
  const rect = target.getBoundingClientRect()
  menuPosition.value = {
    left: Math.max(8, Math.min(window.innerWidth - 260, rect.left)),
    top: Math.max(8, Math.min(window.innerHeight - 44, rect.bottom + 4))
  }
}

watch(() => props.actionMessageId, id => {
  if (!id) menuPosition.value = null
  else nextTick(() => updateMenuPosition())
})

function scrollToBottom() {
  nextTick(() => {
    messageWindowStart.value = Math.max(0, props.messages.length - MESSAGE_WINDOW_SIZE)
    nextTick(() => {
      if (threadEl.value) threadEl.value.scrollTop = threadEl.value.scrollHeight
    })
  })
}

function scrollToMessage(id) {
  if (!id || !threadEl.value) return
  const index = props.messages.findIndex(message => message.id === id)
  if (index < 0) return
  messageWindowStart.value = Math.max(0, Math.min(index - 20, props.messages.length - MESSAGE_WINDOW_SIZE))
  nextTick(() => {
    const el = threadEl.value?.querySelector(`[data-message-id="${id}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('highlight-message')
    setTimeout(() => el.classList.remove('highlight-message'), 1500)
  })
}

defineExpose({ scrollToBottom, scrollToMessage })
</script>

<template>
  <div
    ref="threadEl"
    class="thread"
    @click="emit('thread-click')"
    @dblclick="handleDoubleClick($event, props.messages)"
    @contextmenu.prevent="handleContextMenu($event, props.messages)"
    @dragover.prevent="emit('drag-over', $event)"
    @dragenter.prevent="emit('drag-over', $event)"
    @dragleave.self="emit('drag-leave')"
    @drop.prevent="emit('drag-drop', $event)"
    @scroll.passive="handleThreadScroll"
  >
    <div v-if="draggingFile" class="drop-overlay">שחרר קובץ לצירוף</div>
    <section v-if="!selectedChat" class="empty-thread">
      <h2>בחרו שיחה</h2>
      <p>או פתחו שיחה חדשה לפי מספר.</p>
    </section>
    <section v-else-if="loadingMessages" class="empty-thread loading-thread">
      <span class="spinner" aria-hidden="true"></span>
      <h2>טוען שיחה...</h2>
    </section>
    <section v-else-if="!messages.length" class="empty-thread">
      <h2>אין הודעות בזיכרון</h2>
      <p>אפשר לשלוח הודעה חדשה מכאן.</p>
    </section>
    <button v-if="selectedChat && !loadingMessages" class="older-button" type="button" :disabled="loadingOlder" @click="emit('load-older')">
      {{ loadingOlder ? 'מוריד מהטלפון...' : 'הורד הודעות מהטלפון' }}
    </button>
    <div
      v-if="!loadingMessages && messageTopSpacerHeight"
      class="virtual-spacer"
      :style="{ height: `${messageTopSpacerHeight}px` }"
      aria-hidden="true"
    ></div>
    <div
      v-for="{ message, index: mi } in (loadingMessages ? [] : visibleMessages)"
      :key="message.id"
      class="message-row"
    >
      <div v-if="showDateCaption(mi)" class="date-caption" :key="'date-' + message.id">{{ dateCaption(mi) }}</div>
      <article
        :data-message-id="message.id"
        :class="['bubble', { mine: message.fromMe, deleted: message.deleted, call: isCallMessage(message), menuOpen: actionMessageId === message.id }]"
      >
        <span
          v-show="!textSelected"
          class="drag-handle"
          draggable="true"
          title="גרור להעברה"
          @dragstart.stop="beginBubbleDrag($event, message)"
          @dragend="$event.target.removeAttribute('dragging')"
        >
          <svg class="drag-icon" viewBox="0 0 8 8" aria-hidden="true">
            <circle cx="2" cy="2" r="0.8" fill="currentColor"/>
            <circle cx="6" cy="2" r="0.8" fill="currentColor"/>
            <circle cx="2" cy="6" r="0.8" fill="currentColor"/>
            <circle cx="6" cy="6" r="0.8" fill="currentColor"/>
          </svg>
        </span>
        <button
          v-show="!textSelected"
          class="message-menu-button"
          type="button"
          title="פעולות"
          @click.stop="toggleMessageMenu($event, message)"
        >⋯</button>
        <div v-if=" isForwardedMessage(message)" class="forwarded-label">הועברה</div>
        <strong v-if="!message.fromMe" class="sender-line">
          <span>{{ message.sender }}</span>
          <small v-if="senderNumberLabel(message)">{{ senderNumberLabel(message) }}</small>
        </strong>
        <div v-if=" message.quoted" class="quoted-message" @click="emit('scroll-to-message', message.quoted.id)" :title="message.quoted.text ? 'לחץ לקפוץ להודעה' : 'מדיה'">
          <strong>{{ message.quoted.sender }}</strong>
          <span v-if="message.quoted.text" dir="auto">{{ message.quoted.text }}</span>
          <span v-else class="quoted-media-badge">{{ message.quoted.mediaKind || 'מדיה' }}</span>
        </div>
        <span v-if="!message.deleted && message.viewOnce" class="view-once-label">{{ mediaLabel(message) }}</span>
        <div v-if="!message.deleted && isCallMessage(message)" class="call-message">
          <span aria-hidden="true">{{ message.call?.isVideo ? 'וידאו' : 'קול' }}</span>
          <strong>{{ message.text }}</strong>
        </div>
        <div
          v-else-if=" isDownloadableMedia(message)"
          class="message-media"
          draggable="true"
          title="Drag to another chat to forward"
          @click.stop
          @dragstart.stop="beginMediaDrag($event, message)"
        >
          <button
            v-if="mediaKind(message) !== 'document' && !loadedMediaUrl(message)"
            :class="['media-load-button', { preview: hasMediaPreview(message) }]"
            :style="mediaPreviewStyle(message)"
            type="button"
            :disabled="loadingMedia[message.id]"
            @click="loadMedia(message)"
          >
            {{ loadingMedia[message.id] ? 'טוען...' : mediaActionLabel(message) }}
          </button>
          <a
            v-else-if="mediaKind(message) === 'document'"
            class="media-load-button media-download-link"
            :href="mediaUrl(message)"
            :download="mediaFileName(message)"
            target="_blank"
            rel="noreferrer"
          >
            הורד {{ mediaFileName(message) }}
          </a>
          <a
            v-else-if="mediaKind(message) === 'image' || mediaKind(message) === 'sticker'"
            class="message-image-link"
            :href="loadedMediaUrl(message)"
            target="_blank"
            rel="noreferrer"
            :title="mediaKind(message) === 'sticker' ? 'פתח סטיקר בטאב חדש' : 'פתח תמונה בטאב חדש'"
          >
            <img
              :class="['message-image', { sticker: mediaKind(message) === 'sticker' }]"
              :src="loadedMediaUrl(message)"
              alt=""
              @load="finishMediaLoad(message)"
              @error="finishMediaLoad(message)"
            />
          </a>
          <video
            v-else-if="mediaKind(message) === 'video'"
            class="message-video"
            :src="loadedMediaUrl(message)"
            :style="mediaSizeStyle(message)"
            controls
            preload="metadata"
            @loadedmetadata="finishMediaLoad(message)"
            @error="finishMediaLoad(message)"
          ></video>
          <audio
            v-else
            class="message-audio"
            :src="loadedMediaUrl(message)"
            controls
            preload="metadata"
            @loadedmetadata="finishMediaLoad(message)"
            @error="finishMediaLoad(message)"
          ></audio>
        </div>
        <div v-else-if="!message.deleted && isContactMessage(message)" class="contact-message">
          <span class="contact-icon" aria-hidden="true">&#128100;</span>
          <div class="contact-details">
            <strong class="contact-name" dir="auto">{{ contactDisplayName(message) }}</strong>
            <small v-if="contactPhone(message)" class="contact-phone" dir="ltr">{{ contactPhone(message) }}</small>
            <template v-if="hasMultipleContacts(message)">
              <small class="contact-count">ועוד {{ message.contact.contacts.length - 1 }} אנשי קשר</small>
            </template>
          </div>
          <button
            v-if="contactPhone(message)"
            type="button"
            class="contact-chat-button"
            title="פתח שיחה"
            @click.stop="emit('select-chat', contactPhone(message), contactDisplayName(message))"
          >&#128172;</button>
        </div>
        <div v-else-if="!message.deleted && isInteractiveMessage(message)" class="interactive-message">
          <div v-if="message.interactiveData.title" class="interactive-title" dir="auto">{{ message.interactiveData.title }}</div>
          <div v-if="message.interactiveData.body" class="interactive-body" dir="auto">{{ message.interactiveData.body }}</div>
          <div v-if="message.interactiveData.footer" class="interactive-footer" dir="auto">{{ message.interactiveData.footer }}</div>
          <div v-if="message.interactiveData.buttons?.length" class="interactive-buttons">
            <template v-for="(btn, bi) in message.interactiveData.buttons" :key="bi">
              <a
                v-if="btn.type === 'url' && btn.url"
                :href="btn.url"
                target="_blank"
                rel="noreferrer"
                class="interactive-button interactive-link"
                @click.stop
              >
                {{ btn.text }}
              </a>
              <a
                v-else-if="btn.type === 'call' && btn.phone"
                :href="`tel:${btn.phone}`"
                class="interactive-button interactive-link"
                @click.stop
              >
                {{ btn.text }}
              </a>
              <button
                v-else
                type="button"
                class="interactive-button"
                disabled
              >
                {{ btn.text }}
              </button>
            </template>
          </div>
          <div v-if="message.interactiveData.sections?.length" class="interactive-sections">
            <details v-for="(section, si) in message.interactiveData.sections" :key="si" class="interactive-section">
              <summary v-if="section.title" class="interactive-section-title">{{ section.title }}</summary>
              <ul class="interactive-rows">
                <li v-for="(row, ri) in section.rows" :key="ri" class="interactive-row" dir="auto">
                  <strong>{{ row.title }}</strong>
                  <span v-if="row.description" class="interactive-row-desc">{{ row.description }}</span>
                </li>
              </ul>
            </details>
          </div>
        </div>
        <a
          v-if=" message.linkPreview && linkPreviewHref(message)"
          class="link-preview"
          :href="linkPreviewHref(message)"
          target="_blank"
          rel="noreferrer"
          @click.stop
        >
          <img
            v-if="message.linkPreview.thumbnail"
            :src="message.linkPreview.thumbnail"
            :width="message.linkPreview.thumbnailWidth || undefined"
            :height="message.linkPreview.thumbnailHeight || undefined"
            :style="linkPreviewImageStyle(message.linkPreview)"
            alt=""
            loading="lazy"
            decoding="async"
          />
          <span class="link-preview-copy">
            <strong dir="auto">{{ message.linkPreview.title }}</strong>
            <span v-if="message.linkPreview.description" dir="auto">{{ message.linkPreview.description }}</span>
            <small dir="ltr">{{ linkPreviewHost(message) }}</small>
          </span>
        </a>
        <p v-if="!isCallMessage(message) && !isContactMessage(message) && !isInteractiveMessage(message)" class="message-text" dir="auto">
          <template v-for="(part, index) in formatMessageText(message.text || message.type)" :key="`${message.id}:text:${index}`">
            <a v-if="part.type === 'link'" :class="{ bold: part.bold }" :href="part.href" target="_blank" rel="noreferrer">{{ part.text }}</a>
            <a v-else-if="part.type === 'mention'" :class="{ bold: part.bold }" class="mention-link" href="#" @click.prevent="emit('mention-click', part.jid)">{{ part.text }}</a>
            <strong v-else-if="part.type === 'bold'">{{ part.text }}</strong>
            <span v-else>{{ part.text }}</span>
          </template>
        </p>
        <small v-if="message.edited" class="edited-label">נערך</small>
        <small v-if="message.deleted" class="deleted-label">הודעה נמחקה</small>
        <div v-if="!message.deleted && message.reactions" class="message-reactions">
          <button
            v-for="reaction in messageReactions(message)"
            :key="reactionUserKey(reaction)"
            type="button"
            :title="isMyReaction(reaction) ? 'מחק תגובה' : reaction.sender"
            @click="emit('react', message, reaction.text)"
          >
            {{ reaction.text }}
          </button>
        </div>
        <span class="message-meta">
          <time :title="formatDateFull(message.timestamp)">{{ formatTime(message.timestamp) }}</time>
          <StatusTick
            v-if="shouldShowMessageStatus(message)"
            :message="{ fromMe: message.fromMe, status: message.status, receipt: message.receipt, userReceipt: message.userReceipt, type: message.type, call: message.call, jid: message.jid }"
            :is-group="message.jid?.endsWith('@g.us')"
            :participant-count="Number(currentChat?.jid === message.jid ? currentChat?.participantCount : 0)"
          />
        </span>
      </article>
    </div>
    <!-- Typing indicator under last message -->
    <div v-if="selectedChat" :class="['typing-bubble', { active: currentChat?.typing }]">
      <span v-if="currentChat?.typing" class="typing-indicator">
        <span class="typing-dots"><span></span><span></span><span></span></span>
        <span v-if="currentChat?.isGroup && currentChat?.typing" class="typing-writer">{{ currentChat.typing }}:</span>
        כותב...
      </span>
    </div>
    <Teleport to="body">
      <div
        v-if="actionMessage && menuPosition"
        class="message-menu message-menu-portal"
        :style="{ left: `${menuPosition.left}px`, top: `${menuPosition.top}px` }"
        @click.stop
      >
        <button type="button" @click="emit('reply-message', actionMessage)">השב</button>
        <button v-if="currentChat?.isGroup && !actionMessage.fromMe" type="button" @click="emit('reply-private', actionMessage)">השב בפרטי</button>
        <button type="button" @click="emit('toggle-reaction-menu', actionMessage)">אמוג'י</button>
        <button type="button" :disabled="actionMessage.deleted" @click="emit('delete-message', actionMessage)">מחק</button>
        <button type="button" @click="emit('forward-message', actionMessage)">העבר</button>
        <button type="button" @click="copyWithPrefix(actionMessage)">העתק</button>
        <button type="button" @click="copyAllText(actionMessage)">העתק הכל</button>
        <div v-if="reactionMessageId === actionMessage.id" class="message-reaction-picker">
          <button v-for="emoji in emojis" :key="emoji" type="button" @click="emit('react', actionMessage, emoji)">{{ emoji }}</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>
