<script setup>
import { computed, ref, watch } from 'vue'
import { initials } from './helpers.js'
import { looksLikeLidNumber } from '../../src/contact-vcard.ts'

// Contact-picker modal for sending a vCard. Owns the search box and the
// current selection; the parent receives the chosen contact via `send`.

const props = defineProps({
  open: Boolean,
  contacts: { type: Array, default: () => [] },
  busy: Boolean
})
const emit = defineEmits(['close', 'send'])

const search = ref('')
const selected = ref(null)

function searchable(value) {
  return String(value ?? '').toLowerCase().replace(/@.*$/, '')
}

function cleanPhone(value) {
  return String(value ?? '').replace(/@.*$/, '').replace(/[^\d]/g, '')
}

// Fresh search box and selection on every open
watch(() => props.open, open => {
  if (open) {
    search.value = ''
    selected.value = null
  }
})

const filteredContacts = computed(() => {
  const term = searchable(search.value).trim()
  const list = props.contacts.filter(contact => contact.phoneNumber && contact.name && !looksLikeLidNumber(contact.phoneNumber))
  if (!term) return list.slice(0, 100)
  return list.filter(contact => {
    const nameMatch = searchable(contact.name).includes(term)
    // Search phone by clean digits (strips @s.whatsapp.net suffix)
    const phoneClean = cleanPhone(contact.phoneNumber)
    const phoneMatch = phoneClean.includes(term) || term.includes(phoneClean)
    return nameMatch || phoneMatch
  }).slice(0, 100)
})

function submit() {
  if (!selected.value) return
  emit('send', selected.value)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="open"
        class="modal-mask contact-modal-mask"
        role="dialog"
        aria-modal="true"
        @mousedown.self="emit('close')"
      >
        <section class="modal-wrapper contact-window" @mousedown.stop @keydown.enter.exact.prevent="submit">
          <header class="modal-header">
            <strong>שלח איש קשר</strong>
            <button type="button" class="modal-close" title="סגור" @click="emit('close')">×</button>
          </header>
          <div class="modal-body contact-list">
            <input v-model="search" class="contact-search" placeholder="חיפוש איש קשר" />
            <div class="contact-items">
              <button
                v-for="contact in filteredContacts"
                :key="contact.jid"
                class="contact-item"
                type="button"
                :class="{ selected: selected?.jid === contact.jid }"
                @click="selected = contact"
              >
                <span class="contact-item-avatar">
                  <span class="avatar">{{ initials(contact) }}</span>
                </span>
                <span class="contact-item-name">{{ contact.name }}</span>
                <small class="contact-item-phone">{{ cleanPhone(contact.phoneNumber) || '' }}</small>
              </button>
              <p v-if="!filteredContacts.length" class="empty-list">אין אנשי קשר זמינים</p>
            </div>
          </div>
          <footer class="modal-footer">
            <button type="button" class="light-button" @click="emit('close')">ביטול</button>
            <button type="submit" :disabled="!selected || busy" @click="submit">שלח איש קשר</button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
