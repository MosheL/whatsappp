<script setup>
import { nextTick, onUnmounted, ref, watch } from 'vue'

// File-staging modal for sending files. Owns the staged file list, previews
// and caption; the parent only drives visibility and performs the actual
// upload (emits `send` with { files, caption, forwarded }).

const props = defineProps({
  open: Boolean,
  busy: Boolean,
  chatSelected: Boolean
})
const emit = defineEmits(['close', 'send'])

const files = ref([])
const previews = ref([])
const forwarded = ref(false)
const caption = ref('')
const captionInputRef = ref(null)
const fileInputRef = ref(null)

function isImageFile(file) {
  return Boolean(file?.type?.startsWith('image/'))
}

// Mirrors src/audio-convert.ts — the server transcode is the source of truth,
// this only tells the user up front that the upload will be sent as MP3.
const PLAYABLE_AUDIO_MIME = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/mpeg3', 'audio/x-mpeg-3', 'audio/x-mp3',
  'audio/aac', 'audio/aacp', 'audio/x-aac', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/mp4a-latm'
])
const PLAYABLE_AUDIO_EXT = new Set(['mp3', 'mpga', 'mp2', 'aac', 'm4a', 'm4b', 'm4p', 'm4r', 'mp4a'])
const AUDIO_EXT = new Set([
  ...PLAYABLE_AUDIO_EXT,
  'wav', 'wave', 'ogg', 'oga', 'opus', 'flac', 'amr', 'awb',
  'aiff', 'aif', 'aifc', 'wma', 'mka', 'caf', 'au', 'snd', 'ra', 'ape', 'wv', 'voc'
])

function fileExtension(name) {
  const clean = String(name || '').toLowerCase()
  const dot = clean.lastIndexOf('.')
  return dot < 0 ? '' : clean.slice(dot + 1)
}

function isAudioFile(file) {
  const mime = String(file?.type || '').split(';')[0].trim().toLowerCase()
  if (mime.startsWith('audio/') || mime === 'application/ogg') return true
  return AUDIO_EXT.has(fileExtension(file?.name))
}

function willConvertAudio(file) {
  if (!isAudioFile(file)) return false
  const mime = String(file?.type || '').split(';')[0].trim().toLowerCase()
  const ext = fileExtension(file?.name)
  if (mime && mime !== 'application/octet-stream') return !PLAYABLE_AUDIO_MIME.has(mime)
  return !PLAYABLE_AUDIO_EXT.has(ext)
}

function formatFileSize(size) {
  const value = Number(size) || 0
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}

function revokePreviews() {
  for (const url of previews.value) {
    if (url) URL.revokeObjectURL(url)
  }
}

function clearFiles() {
  revokePreviews()
  files.value = []
  previews.value = []
  forwarded.value = false
  caption.value = ''
}

// Stage a file list (called by the parent on pick / drop / paste / retry)
function openFiles(list = [], forwardedFlag = false, initialCaption = '') {
  clearFiles()
  files.value = Array.isArray(list) ? [...list] : (list ? [list] : [])
  forwarded.value = forwardedFlag
  previews.value = files.value.map(file => (isImageFile(file) ? URL.createObjectURL(file) : ''))
  caption.value = initialCaption
  nextTick(() => captionInputRef.value?.focus())
}

// Focus the caption whenever the modal opens — regardless of the order the
// parent calls openFiles() vs. setting `open` (a bare nextTick can run before
// the opening render is flushed).
watch(() => props.open, open => {
  if (open) nextTick(() => captionInputRef.value?.focus())
})

function removeFile(index) {
  const url = previews.value[index]
  if (url) URL.revokeObjectURL(url)
  files.value = files.value.filter((_, i) => i !== index)
  previews.value = previews.value.filter((_, i) => i !== index)
}

function pickFiles() {
  fileInputRef.value?.click()
}

function onPick(event) {
  const picked = [...(event.target.files || [])]
  if (picked.length) openFiles(picked, false, caption.value)
  event.target.value = ''
}

function onDrop(event) {
  const dropped = [...(event.dataTransfer?.files || [])]
  if (dropped.length) openFiles(dropped, false, caption.value)
}

function send() {
  if (!files.value.length) return
  emit('send', { files: [...files.value], caption: caption.value, forwarded: forwarded.value })
  clearFiles()
}

defineExpose({ openFiles })

onUnmounted(clearFiles)
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="open"
        class="modal-mask upload-modal-mask"
        role="dialog"
        aria-modal="true"
        @mousedown.self="emit('close')"
      >
        <section class="modal-wrapper upload-window" @mousedown.stop>
          <header class="modal-header">
            <strong>שליחת קובץ</strong>
            <button type="button" class="modal-close" title="סגור" aria-label="סגור" @click="emit('close')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41Z" fill="currentColor"/></svg></button>
          </header>
          <form class="modal-body upload-form" @submit.prevent="send">
            <div
              class="upload-dropzone"
              @dragover.prevent
              @drop.prevent="onDrop"
            >
              <ul v-if="files.length" class="upload-file-list">
                <li v-for="(file, index) in files" :key="`${file.name}:${file.size}:${index}`">
                  <img v-if="previews[index]" class="upload-file-thumb" :src="previews[index]" alt="" />
                  <span v-else class="upload-file-icon" aria-hidden="true">📄</span>
                  <span class="upload-file-copy">
                    <strong dir="auto">{{ file.name }}</strong>
                    <small>{{ formatFileSize(file.size) }}</small>
                    <small v-if="willConvertAudio(file)" class="upload-file-convert">🎧 יומר ל‑MP3 לפני השליחה</small>
                  </span>
                  <button type="button" class="upload-file-remove" title="הסר" @click="removeFile(index)">×</button>
                </li>
              </ul>
              <strong v-else>גרור קבצים לכאן</strong>
              <small>אפשר לבחור כמה קבצים, להדביק מהלוח או לגרור</small>
              <button type="button" class="light-button" @click="pickFiles">בחר קובץ</button>
            </div>
            <input ref="captionInputRef" v-model="caption" class="caption-input" :placeholder="files.length > 1 ? 'כיתוב לקובץ הראשון' : 'כיתוב לקובץ'" />
            <input ref="fileInputRef" class="hidden-file-input" type="file" multiple @change="onPick" />
            <div class="upload-actions">
              <button type="button" class="light-button" :disabled="!files.length" @click="clearFiles">נקה</button>
              <button type="submit" :disabled="busy || !files.length || !chatSelected">שלח{{ files.length > 1 ? ` ${files.length}` : '' }}</button>
            </div>
          </form>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
