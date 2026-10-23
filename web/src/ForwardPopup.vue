<script setup>
import { computed, ref, watch } from 'vue'
import { initials } from './helpers.js'

// Forward-target picker. Receives the chat list and the JID to exclude (the
// current chat); emits `select` with the target JID.

const props = defineProps({
  open: Boolean,
  chats: { type: Array, default: () => [] },
  excludeJid: { type: String, default: '' }
})
const emit = defineEmits(['close', 'select'])

const search = ref('')

// Fresh search box on every open
watch(() => props.open, open => {
  if (open) search.value = ''
})

function searchable(value) {
  return String(value ?? '').toLowerCase().replace(/@.*$/, '')
}

const filteredChats = computed(() => {
  const term = searchable(search.value).trim()
  const list = props.chats.filter(chat => chat.jid !== props.excludeJid)
  if (!term) return list.slice(0, 50)
  return list.filter(chat =>
    searchable(chat.name).includes(term)
    || searchable(chat.jid).includes(term)
    || searchable(chat.displayJid).includes(term)
    || searchable(chat.phoneNumber).includes(term)
  ).slice(0, 50)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="open"
        class="modal-mask forward-modal-mask"
        role="dialog"
        aria-modal="true"
        @mousedown.self="emit('close')"
      >
        <section class="modal-wrapper forward-window" @mousedown.stop>
          <header class="modal-header">
            <strong>העבר הודעה ל...</strong>
            <button type="button" class="modal-close" title="סגור" aria-label="סגור" @click="emit('close')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41Z" fill="currentColor"/></svg></button>
          </header>
          <div class="modal-body forward-list">
            <input v-model="search" class="forward-search" placeholder="חיפוש שיחה" />
            <div class="forward-items">
              <button
                v-for="chat in filteredChats"
                :key="chat.jid"
                class="forward-item"
                type="button"
                @click="emit('select', chat.jid)"
              >
                <span class="forward-item-avatar">
                  <span class="avatar">{{ initials(chat) }}</span>
                </span>
                <span class="forward-item-name">{{ chat.name }}</span>
                <small class="forward-item-jid">{{ chat.displayJid || chat.phoneNumber || '' }}</small>
              </button>
              <p v-if="!filteredChats.length" class="empty-list">אין שיחות להצגה</p>
            </div>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
