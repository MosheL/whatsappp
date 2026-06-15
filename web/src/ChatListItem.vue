<script setup>
import { computed } from 'vue'
import { formatTime, formatDateFull, formatLastSeen, initials, avatarUrl, setAvatarCache, getAvatarCache } from './helpers.js'
import { chatPreviewStatus } from './message-renderer.js'
import StatusTick from './StatusTick.vue'

const props = defineProps({
  chat: { type: Object, required: true },
  selectedChat: { type: String, default: '' },
  chatDropJid: { type: String, default: '' },
  selectedBot: { type: String, default: '' }
})

const emit = defineEmits(['select-chat', 'mark-read', 'chat-drag-over', 'chat-drag-leave', 'chat-drop'])

const statusLabel = computed(() => chatPreviewStatus(props.chat))
const initialsText = computed(() => initials(props.chat))
const avatarSrc = computed(() => {
  const jid = props.chat?.jid
  if (jid && getAvatarCache(jid) === false) return ''
  return avatarUrl(props.chat, props.selectedBot)
})
const timeFormatted = computed(() => formatTime(props.chat.timestamp))
const timeTitle = computed(() => formatDateFull(props.chat.timestamp))
const lastSeenTitle = computed(() => props.chat.lastSeen ? formatDateFull(props.chat.lastSeen) : '')
const lastSeenFormatted = computed(() => props.chat.lastSeen ? formatLastSeen(props.chat.lastSeen) : '')
const previewText = computed(() => props.chat.lastMessage || '')
</script>

<template>
  <div
    :class="['chat-item', { active: chat.jid === selectedChat, 'drop-target': chat.jid === chatDropJid }]"
    role="button"
    tabindex="0"
    @click="emit('select-chat', chat.jid)"
    @keydown.enter.prevent="emit('select-chat', chat.jid)"
    @keydown.space.prevent="emit('select-chat', chat.jid)"
    @dragenter="emit('chat-drag-over', $event, chat.jid)"
    @dragover="emit('chat-drag-over', $event, chat.jid)"
    @dragleave="emit('chat-drag-leave', $event, chat.jid)"
    @drop="emit('chat-drop', $event, chat.jid)"
  >
    <span class="chat-avatar">
      <span class="avatar">{{ initialsText }}</span>
      <img
        :src="avatarSrc"
        alt=""
        class="avatar-image"
        loading="lazy"
        decoding="async"
        @load="$event.target.classList.add('loaded'); setAvatarCache(props.chat.jid, true)"
        @error="$event.target.classList.remove('loaded'); setAvatarCache(props.chat.jid, false)"
      />
    </span>
    <span class="chat-copy">
      <strong class="chat-title">
        <span>{{ chat.name }}</span>
        <span v-if="chat.lastSeen && !chat.isGroup" class="last-seen-list" :title="lastSeenTitle">&#183; {{ lastSeenFormatted }}</span>
        <svg v-if="chat.isMuted" class="muted-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 4l16 16" />
          <path d="M14.2 18a2.5 2.5 0 0 1-4.4 0" />
          <path d="M8.6 6.6A4.8 4.8 0 0 1 12 5c2.8 0 5 2.2 5 5v2.2c0 .8.3 1.6.9 2.1l.6.7H9" />
          <path d="M6.3 10.5v1.7c0 .8-.3 1.6-.9 2.1l-.6.7h3.4" />
        </svg>
      </strong>
      <small class="chat-preview-row">
        <template v-if="chat.typing">
          <span class="typing-indicator">
            <span class="typing-dots"><span></span><span></span><span></span></span>
            <span v-if="chat.isGroup && chat.typing" class="typing-writer">{{ chat.typing }}:</span>
            כותב...
          </span>
        </template>
        <template v-else>
          <StatusTick :status-label="statusLabel" />
          <span class="chat-preview-text" :class="{ 'from-me': chat.lastMessageFromMe }">{{ previewText }}</span>
        </template>
      </small>
    </span>
    <span class="chat-meta">
      <time :title="timeTitle">{{ timeFormatted }}</time>
      <span class="chat-actions">
        <button v-if="chat.unread" class="mark-read-v" type="button" title="סמן כנקרא" @click.stop="emit('mark-read', chat.jid)">✓</button>
        <b v-if="chat.unread" :class="{ muted: chat.isMuted }" class="unread-badge">{{ chat.unread }}</b>
      </span>
    </span>
  </div>
</template>
