<script setup>
import { Toast } from './toast.js'
</script>

<template>
  <ul v-if="Toast.state.toasts.length" class="toaster">
    <li
      v-for="toast in Toast.state.toasts"
      :key="toast.id"
      :class="toast.status"
      :title="toast.action ? 'לחיצה לפעולה' : ''"
      @click="Toast.click(toast)"
    >
      <span class="toaster-text">{{ toast.text }}</span>
    </li>
  </ul>
</template>
