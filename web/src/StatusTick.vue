<script setup>
import { computed } from 'vue'
import { messageDeliveryState, isDoubleTick } from './message-renderer.js'

/**
 * Props:
 * - message: an object with fromMe, status, receipt, userReceipt, type, call, jid
 * - isGroup: boolean
 * - participantCount: number
 * - statusLabel: optional override string (e.g. from chat preview)
 *
 * If statusLabel is provided, it is used directly instead of computing it.
 */
const props = defineProps({
  message: { type: Object, default: null },
  isGroup: { type: Boolean, default: false },
  participantCount: { type: Number, default: 0 },
  statusLabel: { type: String, default: '' }
})

const status = computed(() => {
  if (props.statusLabel) return props.statusLabel
  if (!props.message) return ''
  return messageDeliveryState(props.message, props.isGroup, props.participantCount)
})

const showStatus = computed(() => {
  return Boolean(status.value)
})

const isDouble = computed(() => {
  if (props.statusLabel) return props.statusLabel !== 'sent'
  if (!props.message) return false
  return isDoubleTick(props.message, props.isGroup, props.participantCount)
})
</script>

<template>
  <span v-if="showStatus" :class="['message-status', status]" class="chat-status-tick">
    <svg
      :class="['tick-icon', { double: isDouble }]"
      viewBox="0 0 18 11"
      aria-hidden="true"
    >
      <path class="tick-back" d="M1.2 5.7 4.6 9 11.7 1.4" />
      <path v-if="isDouble" class="tick-front" d="M6.1 5.7 9.5 9 16.6 1.4" />
    </svg>
  </span>
</template>
