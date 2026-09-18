<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { onClickOutside } from '@vueuse/core'
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
  isInteractiveMessage, isLocationMessage, interactiveTypeLabel, isUnsupportedMessage
} from './message-renderer.js'
import MessageBubble from './MessageBubble.vue'

// Track typing clear timers per chat JID
const typingTimers = new Map()
const threadEl = ref(null)
const textSelected = ref(false)
const messageMenuRef = ref(null)

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
  onClickOutside(messageMenuRef, () => {
    if (props.actionMessageId) {
      emit('toggle-message-menu', actionMessage.value)
    }
  })
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
  if (textSelected.value && props.actionMessageId) {
    emit('toggle-message-menu', actionMessage.value)
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
  'forward-message',
  'button-reply'
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
  // Allow browser native right-click on images and videos
  const target = event.target
  if (target.closest?.('img, video')) return
  event.preventDefault()
  const bubble = event.target.closest?.('.bubble')
  if (!bubble) return
  const messageId = bubble.dataset?.messageId
  if (!messageId) return
  const message = messages.find(m => m.id === messageId)
  if (message) {
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

function copyInteractiveCode(code) {
  if (!code) return
  const text = String(code)
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => copyTextFallback(text))
  } else {
    copyTextFallback(text)
  }
}

// Tapped quick-reply buttons per message, so they render as used.
const sentButtons = ref(new Set())

function sendButtonReply(message, btn, index) {
  if (!btn?.text || sentButtons.value.has(`${message.id}:${index}`)) return
  sentButtons.value.add(`${message.id}:${index}`)
  emit('button-reply', { jid: message.jid, text: btn.text, buttonId: btn.id || '', selectedIndex: index, messageId: message.id })
}

const bubbleActions = { emit, beginBubbleDrag, beginMediaDrag, toggleMessageMenu, mediaUrl,
  loadMedia, finishMediaLoad, copyInteractiveCode, sendButtonReply }

// Keep loaded history in the DOM for native find-in-page. CSS skips off-screen
// layout and painting; stable MessageBubble props avoid unrelated Vue updates.
const visibleMessages = computed(() => props.messages.map((message, index) => ({ message, index })))
const actionMessage = computed(() => props.messages.find(message => message.id === props.actionMessageId))

onUnmounted(() => document.removeEventListener('selectionchange', onSelectionChange))

// Distance from the bottom (in pixels) at which we still consider the user
// to be "at the bottom" and auto-scroll on new messages. Anything beyond this
// keeps the scroll position and surfaces a "scroll down" button instead.
const STICK_TO_BOTTOM_THRESHOLD = 120
// When new messages pile up while the user is scrolled up, this ref tracks the
// unread count for the floating "scroll down" indicator.
const newMessageCount = ref(0)
// True when the user is currently within `STICK_TO_BOTTOM_THRESHOLD` of the
// bottom edge. Used to decide whether new messages should auto-scroll or be
// counted as pending. Starts true so the initial render behaves as "at bottom".
const isNearBottom = ref(true)

function updateNearBottom() {
  const el = threadEl.value
  if (!el) return
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  isNearBottom.value = distance <= STICK_TO_BOTTOM_THRESHOLD
  // If the user manually scrolled back to the bottom, the pending counter
  // becomes irrelevant — clear it.
  if (isNearBottom.value && newMessageCount.value > 0) {
    newMessageCount.value = 0
  }
}

function handleThreadScroll() {
  const el = threadEl.value
  if (!el) return
  updateNearBottom()

}

function toggleMessageMenu(event, message) {
  emit('toggle-message-menu', message)
}

// Conditional scroll: only actually moves to the bottom when the user is
// already near the bottom. Otherwise the user stays put and we bump the
// "new messages" counter so a floating button can offer to jump down.
function scrollToBottom(message) {
  if (!isNearBottom.value) {
    // Messages sent by the current user should not appear as unread in the
    // floating indicator while they are scrolled away from the bottom.
    if (message?.fromMe === false) newMessageCount.value += 1
    return
  }
  performScrollToBottom()
  newMessageCount.value = 0
}

// Unconditional scroll: always jumps to the bottom and resets the counter.
// Used by chat-switching, initial loads and the "scroll down" button.
function forceScrollToBottom() {
  performScrollToBottom()
  newMessageCount.value = 0
  isNearBottom.value = true
}

function performScrollToBottom() {
  nextTick(() => {
    const el = threadEl.value
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
  })
}

function scrollToMessage(id) {
  if (!id || !threadEl.value) return
  const index = props.messages.findIndex(message => message.id === id)
  if (index < 0) return
  isNearBottom.value = false
  nextTick(() => {
    const el = threadEl.value?.querySelector(`[data-message-id="${id}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('highlight-message')
    setTimeout(() => el.classList.remove('highlight-message'), 1500)
  })
}

// Reset per-chat state when the active chat changes: pending counter and
// sticky-to-bottom flag should not leak between conversations.
watch(() => props.selectedChat, () => {
  newMessageCount.value = 0
  isNearBottom.value = true
})

// Hide the floating button whenever the thread is being repopulated from
// scratch (loading older history) so it doesn't dangle during the brief
// window where there are no messages.
watch(() => props.loadingMessages, (loading) => {
  if (loading) newMessageCount.value = 0
})

defineExpose({ scrollToBottom, scrollToMessage, forceScrollToBottom })
</script>

<template>
  <div
    ref="threadEl"
    class="thread"
    @click="emit('thread-click')"
    @dblclick="handleDoubleClick($event, props.messages)"
    @contextmenu="handleContextMenu($event, props.messages)"
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
    <MessageBubble
      v-for="{ message, index: mi } in (loadingMessages ? [] : visibleMessages)"
      :key="message.id"
      :message="message"
      :date-label="showDateCaption(mi) ? dateCaption(mi) : ''"
      :menu-open="actionMessageId === message.id"
      :text-selected="textSelected"
      :media-loading="Boolean(loadingMedia[message.id])"
      :loaded-url="loadedMediaUrl(message) || ''"
      :participant-count="Number(currentChat?.jid === message.jid ? currentChat?.participantCount : 0)"
      :sent-buttons="sentButtons"
      :actions="bubbleActions"
    />
    <!-- Typing indicator under last message -->
    <div v-if="selectedChat" :class="['typing-bubble', { active: currentChat?.typing }]">
      <span v-if="currentChat?.typing" class="typing-indicator">
        <span class="typing-dots"><span></span><span></span><span></span></span>
        <span v-if="currentChat?.isGroup && currentChat?.typing" class="typing-writer">{{ currentChat.typing }}:</span>
        כותב...
      </span>
    </div>
    <!-- Floating "scroll to latest" indicator. Rendered as the last in-flow
         child of the thread so that `position: sticky; bottom` (the sticky-
         footer pattern) pins it to the viewport's bottom edge. Shown whenever
         the user has scrolled away from the bottom (`!isNearBottom`), not only
         when new messages are pending — so it always offers a way back down.
         The red unread badge is driven by `data-count`, which is set only while
         there actually are pending new messages. -->
    <button
      v-if="selectedChat && !loadingMessages && !isNearBottom"
      type="button"
      class="scroll-down"
      :data-count="newMessageCount > 0 ? (newMessageCount > 9 ? '9+' : String(newMessageCount)) : null"
      :title="newMessageCount > 0 ? `${newMessageCount} הודעות חדשות` : 'גלול לתחתית'"
      :aria-label="newMessageCount > 0 ? `גלול ל-${newMessageCount} הודעות חדשות` : 'גלול לתחתית'"
      @click="forceScrollToBottom"
    >
      <span class="scroll-down-icon" aria-hidden="true">&#x25BC;</span>
    </button>
    <Teleport to="body">
      <div
        v-if="actionMessage && actionMessageId"
        ref="messageMenuRef"
        class="message-menu message-menu-portal"
        :style="{ '--anchor-name': `--mm-${(actionMessage.id).replace(/[^a-zA-Z0-9]/g, '-')}` }"
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
