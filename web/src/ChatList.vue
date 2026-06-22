<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import ChatListItem from './ChatListItem.vue'

const props = defineProps({
  chats: { type: Array, default: () => [] },
  selectedChat: { type: String, default: '' },
  loadingChats: { type: Boolean, default: false },
  chatDropJid: { type: String, default: '' },
  selectedBot: { type: String, default: '' }
})

const emit = defineEmits(['select-chat', 'mark-read', 'chat-drag-over', 'chat-drag-leave', 'chat-drop', 'toggle-archive', 'toggle-mute'])

const CHAT_ITEM_HEIGHT = 72
const CHAT_OVERSCAN = 8
const listEl = ref(null)
const windowStart = ref(0)
const windowSize = ref(40)

const visibleChats = computed(() => props.chats.slice(windowStart.value, windowStart.value + windowSize.value))
const topSpacerHeight = computed(() => windowStart.value * CHAT_ITEM_HEIGHT)
const bottomSpacerHeight = computed(() => (
  Math.max(0, props.chats.length - windowStart.value - visibleChats.value.length) * CHAT_ITEM_HEIGHT
))

function updateWindow() {
  const el = listEl.value
  if (!el) return
  windowStart.value = Math.max(0, Math.floor(el.scrollTop / CHAT_ITEM_HEIGHT) - CHAT_OVERSCAN)
  windowSize.value = Math.ceil(el.clientHeight / CHAT_ITEM_HEIGHT) + CHAT_OVERSCAN * 2
}

watch(() => props.chats, () => nextTick(updateWindow), { flush: 'post' })

</script>

<template>
  <nav ref="listEl" class="chat-list" @scroll.passive="updateWindow">
    <p v-if="loadingChats" class="empty-list">טוען שיחות אחרונות...</p>
    <p v-else-if="!chats.length" class="empty-list">אין שיחות להצגה</p>
    <div v-if="topSpacerHeight" class="virtual-spacer" :style="{ height: `${topSpacerHeight}px` }" aria-hidden="true"></div>
    <ChatListItem
      v-for="chat in visibleChats"
      :key="chat.jid"
      :chat="chat"
      :selected-chat="selectedChat"
      :chat-drop-jid="chatDropJid"
      :selected-bot="selectedBot"
      @select-chat="emit('select-chat', $event)"
      @mark-read="emit('mark-read', $event)"
      @toggle-archive="(jid, archive) => emit('toggle-archive', jid, archive)"
      @toggle-mute="(jid, muted) => emit('toggle-mute', jid, muted)"
      @chat-drag-over="emit('chat-drag-over', $event, chat.jid)"
      @chat-drag-leave="emit('chat-drag-leave', $event, chat.jid)"
      @chat-drop="emit('chat-drop', $event, chat.jid)"
    />
    <div v-if="bottomSpacerHeight" class="virtual-spacer" :style="{ height: `${bottomSpacerHeight}px` }" aria-hidden="true"></div>
  </nav>
</template>
