<script setup>
import { nextTick, ref, watch } from 'vue'

// Edit-message modal. Owns only the draft text; the parent performs the API
// call and passes busy/error state. Emits `save` with the new text.

const props = defineProps({
  message: { type: Object, default: null },
  busy: Boolean,
  error: { type: String, default: '' }
})
const emit = defineEmits(['close', 'save'])

const draft = ref('')
const textAreaRef = ref(null)

watch(() => props.message, message => {
  draft.value = message?.text || ''
  if (message) {
    nextTick(() => {
      textAreaRef.value?.focus()
      const end = draft.value.length
      textAreaRef.value?.setSelectionRange(end, end)
    })
  }
}, { immediate: true })

function submit() {
  const nextText = draft.value.trim()
  if (!nextText) return
  emit('save', nextText)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="message"
        class="modal-mask edit-modal-mask"
        role="dialog"
        aria-modal="true"
        @mousedown.self="emit('close')"
      >
        <section class="modal-wrapper edit-window" @mousedown.stop>
          <header class="modal-header">
            <strong>עריכת הודעה</strong>
            <button type="button" class="modal-close" title="סגור" @click="emit('close')">×</button>
          </header>
          <form class="modal-body edit-form" @submit.prevent="submit">
            <textarea
              ref="textAreaRef"
              v-model="draft"
              class="edit-textarea"
              rows="4"
              dir="auto"
              placeholder="הודעה"
              @keydown.esc.stop.prevent="emit('close')"
            ></textarea>
            <p v-if="error" class="error">{{ error }}</p>
            <div class="edit-actions">
              <button type="button" class="light-button" :disabled="busy" @click="emit('close')">בטל</button>
              <button type="submit" :disabled="busy || !draft.trim()">{{ busy ? 'שומר...' : 'שמור' }}</button>
            </div>
          </form>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
