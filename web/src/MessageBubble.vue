<script setup>
import { computed } from 'vue'
import { formatTime, formatDateFull } from './helpers.js'
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
import StatusTick from './StatusTick.vue'


const props = defineProps({
  message: { type: Object, required: true },
  dateLabel: { type: String, default: '' },
  menuOpen: Boolean,
  textSelected: Boolean,
  mediaLoading: Boolean,
  loadedUrl: { type: String, default: '' },
  participantCount: { type: Number, default: 0 },
  sentButtons: { type: Set, required: true },
  actions: { type: Object, required: true }
})
// One stable action table; state affecting a bubble is passed separately.
const { emit, beginBubbleDrag, beginMediaDrag, toggleMessageMenu, mediaUrl,
  loadMedia, finishMediaLoad, copyInteractiveCode, sendButtonReply } = props.actions
const formattedText = computed(() => formatMessageText(props.message.text || props.message.type))
const formattedBody = computed(() => formatMessageText(props.message.interactiveData?.body || ''))
const displayTime = computed(() => formatTime(props.message.timestamp))
const fullTime = computed(() => formatDateFull(props.message.timestamp))
</script>

<template>
    <div
      :data-row-id="message.id"
       :class="['message-row', { 'has-video': mediaKind(message) === 'video' }]"
    >
      <div v-if="dateLabel" class="date-caption" :key="'date-' + message.id">{{ dateLabel }}</div>
      <div
        :class="['message-item', { mine: message.fromMe, menuOpen: menuOpen }]"
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
          :class="['message-menu-button', { open: menuOpen }]"
          :style="{ '--anchor-name': `--mm-${message.id.replace(/[^a-zA-Z0-9]/g, '-')}` }"
          type="button"
          title="פעולות"
          @click.stop="toggleMessageMenu($event, message)"
        >⋯</button>
        <article
          :data-message-id="message.id"
          :class="['bubble', { mine: message.fromMe, deleted: message.deleted, call: isCallMessage(message), menuOpen: menuOpen }]"
        >
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
        >
          <button
            v-if="mediaKind(message) !== 'document' && !loadedUrl"
            :class="['media-load-button', { preview: hasMediaPreview(message) }]"
            :style="mediaPreviewStyle(message)"
            type="button"
            :disabled="mediaLoading"
            @click="loadMedia(message)"
          >
            {{ mediaLoading ? 'טוען...' : mediaActionLabel(message) }}
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
            :href="loadedUrl"
            target="_blank"
            rel="noreferrer"
            :title="mediaKind(message) === 'sticker' ? 'פתח סטיקר בטאב חדש' : 'פתח תמונה בטאב חדש'"
          >
            <img
              :class="['message-image', { sticker: mediaKind(message) === 'sticker' }]"
              :src="loadedUrl"
              alt=""
              draggable="true"
              @dragstart.stop="beginMediaDrag($event, message)"
              @load="finishMediaLoad(message)"
              @error="finishMediaLoad(message)"
            />
          </a>
          <div
            v-else-if="mediaKind(message) === 'video'"
            class="video-media" :style="mediaSizeStyle(message)" @pointerdown.stop
              @click.stop
              @dblclick.stop
              @dragstart.stop
              @mousemove.stop @mouseenter.stop
          >
            <span
              class="media-drag-handle"
              draggable="true"
              title="Drag video to another chat"
              @dragstart.stop="beginMediaDrag($event, message)"
            >⠿</span>
            <video
              class="message-video"
              :src="loadedUrl"
              :style="mediaSizeStyle(message)"
              draggable="false" autoplay 
              controls
              preload="metadata"          
              @loadedmetadata="finishMediaLoad(message)"
              @error="finishMediaLoad(message)"
            ></video>
          </div>
          <audio
            v-else
            class="message-audio"
            :src="loadedUrl"
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
              <small class="contact-count">ועוד {{ (message.contact?.contacts?.length || 1) - 1 }} אנשי קשר</small>
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
        <!-- Location block. Guarded because old messages persisted before
             validation may have `type: 'locationMessage'` with no actual
             location payload (or with malformed coordinates), which would
             throw `Cannot read properties of undefined (reading 'name')`
             during render. -->
        <div v-else-if=" isLocationMessage(message) && message.location" class="location-message">
          <div v-if="message.location.name" class="location-name" dir="auto">{{ message.location.name }}</div>
          <div v-if="message.location.address" class="location-address" dir="auto">{{ message.location.address }}</div>
          <div v-if="message.location.comment" class="location-comment" dir="auto">{{ message.location.comment }}</div>
          <template v-if="Number.isFinite(message.location.latitude) && Number.isFinite(message.location.longitude)">
            <iframe
              class="location-map"
              :src="`https://www.openstreetmap.org/export/embed.html?bbox=${message.location.longitude - 0.01}%2C${message.location.latitude - 0.01}%2C${message.location.longitude + 0.01}%2C${message.location.latitude + 0.01}&amp;layer=mapnik&amp;marker=${message.location.latitude}%2C${message.location.longitude}`"
              width="100%"
              height="200"
              style="border:0;border-radius:8px;"
              loading="lazy"
              referrerpolicy="no-referrer"
            ></iframe>
            <a
              :href="`https://www.openstreetmap.org/?mlat=${message.location.latitude}&amp;mlon=${message.location.longitude}`"
              target="_blank"
              rel="noreferrer"
              class="location-open-link"
            >
              פתח מפה
            </a>
          </template>
          <a
            v-if="message.location.url"
            :href="message.location.url"
            target="_blank"
            rel="noreferrer"
            class="location-url"
          >
            {{ message.location.url }}
          </a>
        </div>
        <!-- Fallback for legacy location messages whose payload was lost: still
             acknowledge the type without crashing on missing fields. -->
        <div v-else-if="!message.deleted && message.type === 'locationMessage'" class="unsupported-message" dir="auto">
          <span class="unsupported-icon" aria-hidden="true">📍</span>
          <span class="unsupported-text">מיקום</span>
        </div>
        <div v-else-if="!message.deleted && isInteractiveMessage(message) && message.interactiveData" class="interactive-message">
          <div v-if="message.interactiveData.title" class="interactive-title" dir="auto">{{ message.interactiveData.title }}</div>
          <div v-if="message.interactiveData.body" class="interactive-body" dir="auto">
            <template v-for="(part, index) in formattedBody" :key="`${message.id}:ibody:${index}`">
              <a v-if="part.type === 'link'" :class="{ bold: part.bold, strike: part.strike }" :href="part.href" target="_blank" rel="noreferrer">{{ part.text }}</a>
              <a v-else-if="part.type === 'email'" :class="{ bold: part.bold, strike: part.strike }" :href="part.href" target="_blank" rel="noreferrer">{{ part.text }}</a>
              <strong v-else-if="part.bold && !part.strike">{{ part.text }}</strong>
              <strong v-else-if="part.bold && part.strike"><del>{{ part.text }}</del></strong>
              <del v-else-if="part.strike">{{ part.text }}</del>
              <span v-else>{{ part.text }}</span>
            </template>
          </div>
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
                v-else-if="btn.type === 'copy_code' && btn.code"
                type="button"
                class="interactive-button interactive-link"
                :title="`העתק: ${btn.code}`"
                @click.stop="copyInteractiveCode(btn.code)"
              >
                {{ btn.text }}
              </button>
              <button
                v-else-if="btn.type === 'quick_reply'"
                type="button"
                class="interactive-button"
                :class="{ 'interactive-button-sent': sentButtons.has(`${message.id}:${bi}`) }"
                @click.stop="sendButtonReply(message, btn, bi)"
              >
                {{ btn.text }}
              </button>
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
        <div v-if="!message.deleted && isUnsupportedMessage(message)" class="unsupported-message" dir="auto">
          <span class="unsupported-icon" aria-hidden="true">⚠️</span>
          <span class="unsupported-text">הודעה לא נתמכת</span>
          <small v-if="message.type" class="unsupported-type" dir="ltr">{{ message.type }}</small>
        </div>
        <p v-if="!isCallMessage(message) && !isContactMessage(message) && !isInteractiveMessage(message) && !isUnsupportedMessage(message)" class="message-text" dir="auto">
          <template v-for="(part, index) in formattedText" :key="`${message.id}:text:${index}`">
            <a v-if="part.type === 'link'" :class="{ bold: part.bold, strike: part.strike }" :href="part.href" target="_blank" rel="noreferrer">{{ part.text }}</a>
            <a v-else-if="part.type === 'email'" :class="{ bold: part.bold, strike: part.strike }" :href="part.href" target="_blank" rel="noreferrer">{{ part.text }}</a>
            <a v-else-if="part.type === 'mention'" :class="{ bold: part.bold, strike: part.strike }" class="mention-link" href="#" @click.prevent="emit('mention-click', part.jid)">{{ part.text }}</a>
            <strong v-else-if="part.bold && !part.strike">{{ part.text }}</strong>
            <strong v-else-if="part.bold && part.strike"><del>{{ part.text }}</del></strong>
            <del v-else-if="part.strike">{{ part.text }}</del>
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
          <time :title="fullTime">{{ displayTime }}</time>
          <StatusTick
            v-if="shouldShowMessageStatus(message)"
            :message="message"
            :is-group="message.jid?.endsWith('@g.us')"
            :participant-count="participantCount"
          />
        </span>
      </article>
      </div>
    </div>
</template>
