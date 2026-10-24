<script setup>
import QRCode from 'qrcode'
import { createRequestPool } from './request-pool.js'
import { createSearchIndexer, matchesSearch, searchQuery } from './search-index.js'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { useBlob } from './composables/useBlob.js'
import { wsState, connectSocket, disconnectSocket, isOpen, isClosed } from './socket.js'
import {
  formatTime, formatDateFull, formatDateCaption, formatLastSeen, initials, avatarUrl, setAvatarCache, getAvatarCache, AVATAR_VERSION
} from './helpers.js'
import {
  hasLinkCandidate, linkPreviewHref, linkPreviewHost, linkPreviewImageStyle, messagePreview
} from './message-renderer.js'
import { messageStatusRank, mergeMessagePatch, reactionUserKey, isMessageEditable } from '../../src/message-utils.ts'
import { buildContactVcard, looksLikeLidNumber } from '../../src/contact-vcard.ts'
import ChatList from './ChatList.vue'
import ChatThread from './ChatThread.vue'
import SearchPopup from './SearchPopup.vue'
import ChatInfoPopup from './ChatInfoPopup.vue'
import Toaster from './Toaster.vue'
import UploadModal from './UploadModal.vue'
import ForwardPopup from './ForwardPopup.vue'
import EditPopup from './EditPopup.vue'
import ContactPickerModal from './ContactPickerModal.vue'
import Toast from './toast.js'
import { searchEmojiCatalog } from './emoji-catalog.js'

const authenticated = ref(false)
const password = ref('')
const loginError = ref('')
const bots = ref([])
const selectedBot = ref(localStorage.getItem('wa-ui-selected-bot') || '')
const chats = ref([])
const messages = ref([])
const selectedChat = ref('')
const search = ref('')
const showMenu = ref(false)
const chatMenuRef = ref(null)

// Collapse the menu popover when clicking outside it
onClickOutside(chatMenuRef, () => {
  if (showMenu.value) showMenu.value = false
})
const showArchived = ref(localStorage.getItem('wa-ui-show-archived') === 'true')
const autoMarkRead = ref(localStorage.getItem('wa-ui-auto-mark-read') === 'true')
const contacts = ref([])
const avatarLoaded = ref(false)
const avatarCache = {}
const newJid = ref('')
const text = ref('')
const textAreaRef = ref(null)
// File currently being uploaded: shown as an in-composer "uploading strip"
// after the modal closes, until the send completes or fails.
const uploadingFile = ref(null)
const fileInputRef = ref(null)
const uploadModalRef = ref(null)
const draggingFile = ref(false)
const chatDropJid = ref('')
const showUploadModal = ref(false)
const showForwardPopup = ref(false)
const showContactPicker = ref(false)
const showSearchPopup = ref(localStorage.getItem('wa-ui-search-open') === 'true')
const showChatInfo = ref(false)
const forwardMessageId = ref('')
const forwardSourceJid = ref('')
const forwardTargetJid = ref('')
const actionMessageId = ref('')
const reactionMessageId = ref('')
// Message under the pointer — target for the Delete / Shift+Delete shortcut.
const hoveredMessageId = ref('')
const replyTo = ref(null)
const editingMessage = ref(null)
const editError = ref('')
const editBusy = ref(false)
const emojiPanelOpen = ref(false)
const busy = ref(false)
const composerLinkPreview = ref(null)
const loadingLinkPreview = ref(false)
const groupParticipants = ref([])
const selectedMentions = ref([])
const mentionQuery = ref(null)
const mentionIndex = ref(0)
const loadingChats = ref(false)
const loadingMessages = ref(false)
const loadingOlder = ref(false)
const error = ref('')
// Surface every error as a toast instead of an inline banner in the composer
watch(error, value => {
  if (value) Toast.error(value)
})
const qrImages = ref({})
const threadRef = ref(null)
let dragHideTimer
let linkPreviewTimer
let lastVisibilityResync = 0
let sessionReady = false
const requestPool = createRequestPool()
let contactsLoadedAt = 0
let contactsLoadedBot = ''
let chatLoadRequest = 0
let messageLoadRequest = 0
let linkPreviewRequest = 0
const markingRead = new Set()

const { url: uploadingPreviewUrl, setBlob: setUploadingPreviewBlob, clearBlob: clearUploadingPreviewBlob } = useBlob()

function loadUsedEmojis() {
  try {
    const value = JSON.parse(localStorage.getItem('wa-ui-used-emojis') || '[]')
    return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 24) : []
  } catch {
    return []
  }
}

const defaultEmojis = ['😀', '😂', '🙂', '😍', '🙏', '👍', '👎', '💪', '❤️', '🔥', '🎉', '✅', '❌', '😅', '😎', '🤔', '😢', '😡', '👏', '👌', '🌹', '☕', '📌', '📎', '🤣', '🥹', '😇', '😘', '👸', '🤦‍♂️', '🤯', '😉', '😲', '😯', '😟', '🥲', '🥳']
const textEmojiMap = {
  ':-)': '🙂',
  ':)': '🙂',
  ':-D': '😀',
  ':D': '😀',
  ':-P': '😛',
  ':P': '😛',
  ':-p': '😛',
  ':p': '😛',
  ':-(': '🙁',
  ':(': '🙁',
  ':-/': '😕',
  ':/': '😕',
  ';)': '😉',
  ';-)': '😉',
  '[V]': '✅',
  '[v]': '✅'
}
const textEmojiPattern = /(^|[\s([{])(:-\)|:\)|:-D|:D|:-P|:P|:-p|:p|:-\(|:\(|:-\/|:\/|;-\)|;\)|\[V\]|\[v\])(?=$|[\s.,!?;:)\]}])/g
const usedEmojis = ref(loadUsedEmojis())

const currentBot = computed(() => bots.value.find(bot => bot.id === selectedBot.value))
const chatsById = computed(() => new Map(chats.value.map(chat => [chat.jid, chat])))
const contactsById = computed(() => {
  const index = new Map()
  for (const contact of contacts.value) {
    for (const key of [contact.jid, contact.phoneNumber]) if (key && !index.has(key)) index.set(key, contact)
  }
  return index
})
const currentChat = computed(() => chatsById.value.get(selectedChat.value))
// Announcement group the linked account cannot post to (only admins may send).
const isReadOnly = computed(() => Boolean(currentChat.value?.readOnly))
const chatTitle = computed(() => currentChat.value?.name || selectedChat.value || 'בחרו שיחה')
const chatSubtitle = computed(() => ""/* currentChat.value ? chatAddress(currentChat.value) : selectedChat.value*/)
const emojis = computed(() => [...new Set([...usedEmojis.value, ...defaultEmojis])].slice(0, 48))
const emojiSearch = ref('')
const emojiResults = computed(() => searchEmojiCatalog(emojiSearch.value))
// Total unread messages across all chats (used by the taskbar badge).
// Sum the per-chat unread counts rather than counting chats, so the badge
// reflects the real number of unread messages instead of topping out at the
// number of chats that happen to have unread.
const unreadTotal = computed(() => chats.value.reduce((sum, chat) => sum + Math.max(0, Number(chat.unread || 0)), 0))
const archivedCount = computed(() => chats.value.filter(chat => chat.isArchived).length)
const archivedUnreadCount = computed(() => chats.value.filter(chat => chat.isArchived && Number(chat.unread || 0) > 0).length)
const inboxUnreadCount = computed(() => chats.value.filter(chat => !chat.isArchived && Number(chat.unread || 0) > 0).length)
const orderedChats = computed(() => [...chats.value].sort((a, b) => {
  const aActive = Number(Boolean(a.timestamp || a.lastMessage))
  const bActive = Number(Boolean(b.timestamp || b.lastMessage))
  if (aActive !== bActive) return bActive - aActive
  return (b.timestamp || 0) - (a.timestamp || 0)
}))
const indexSearch = createSearchIndexer()
const chatSearchIndex = computed(() => new Map(chats.value.map(chat => [chat.jid, indexSearch(chat)])))
const contactSearchIndex = computed(() => contacts.value.map(indexSearch))
const chatIdentityKeys = computed(() => new Set([...chatSearchIndex.value.values()].flatMap(entry => entry.keys)))
const filteredChats = computed(() => {
  const query = searchQuery(search.value)
  let list = orderedChats.value.filter(chat => Boolean(chat.isArchived) === showArchived.value)
  if (!query.term) return list
  list = list.filter(chat => matchesSearch(chatSearchIndex.value.get(chat.jid), query))
  const seenIdentities = new Set(chatIdentityKeys.value)
  const matchedContacts = []
  for (const entry of contactSearchIndex.value) {
    if (entry.keys.some(key => seenIdentities.has(key)) || !matchesSearch(entry, query)) continue
    entry.keys.forEach(key => seenIdentities.add(key))
    const contact = entry.item
    const jid = contact?.phoneNumber || contact?.jid || ''
    const displayJid = safeText(contact?.phoneNumber || contact?.jid).replace(/@.*$/, '')
    matchedContacts.push({
      jid,
      displayJid,
      phoneNumber: contact?.phoneNumber || '',
      name: contact?.name || displayJid || jid,
      lastMessage: '',
      timestamp: 0,
      unread: 0,
      isGroup: false,
      isMuted: false,
      isArchived: false
    })
  }
  return [...list, ...matchedContacts]
})
const mentionSuggestions = computed(() => {
  if (mentionQuery.value === null || !currentChat.value?.isGroup) return []
  const query = searchable(mentionQuery.value)
  return groupParticipants.value
    .filter(participant => participantMentionToken(participant))
    .filter(participant => !query
      || searchable(participant.name).includes(query)
      || safeText(participant.phoneNumber).includes(query))
    .slice(0, 8)
})

function safeText(value) {
  return String(value ?? '')
}

function searchable(value) {
  return safeText(value).toLowerCase()
}

function searchableIdentity(value) {
  return searchable(value).replace(/@.*$/, '')
}

function identityMatches(value, term) {
  return Boolean(term) && searchableIdentity(value).includes(term)
}

function phoneSearchTerms(value) {
  const digits = safeText(value).replace(/[^\d]/g, '')
  if (!digits) return []
  const terms = new Set([digits])
  if (digits.startsWith('0')) terms.add(`972${digits.slice(1)}`)
  if (digits.startsWith('972')) terms.add(`0${digits.slice(3)}`)
  return [...terms]
}

function chatPhoneValues(chat) {
  return [chat.phoneNumber, chat.displayJid, chat.jid]
    .filter(Boolean)
    .flatMap(value => phoneSearchTerms(String(value)))
}

function identityKeys(item) {
  const keys = new Set()
  for (const value of [item?.jid, item?.phoneNumber, item?.displayJid]) {
    const text = searchableIdentity(value)
    if (!text) continue
    keys.add(text)
    for (const phoneTerm of phoneSearchTerms(text)) keys.add(`phone:${phoneTerm}`)
  }
  return [...keys]
}

function chatAddress(chat) {
  if (!chat) return ''
  return chat.phoneNumber || chat.displayJid || chat.jid || ''
}

function participantMentionToken(participant) {
  return String(participant?.phoneNumber || '').replace(/@s\.whatsapp\.net$/, '').replace(/[^\d]/g, '')
}

function draftKey(bot = selectedBot.value, jid = selectedChat.value) {
  if (!bot || !jid) return ''
  return `wa-ui-draft:${bot}:${jid}`
}

function loadDraft(bot = selectedBot.value, jid = selectedChat.value) {
  const key = draftKey(bot, jid)
  return key ? localStorage.getItem(key) || '' : ''
}

function saveDraft(value = text.value, bot = selectedBot.value, jid = selectedChat.value) {
  const key = draftKey(bot, jid)
  if (!key) return
  if (value) localStorage.setItem(key, value)
  else localStorage.removeItem(key)
}

function normalizeJid(value) {
  const clean = value.trim()
  if (!clean) return ''
  if (clean.includes('@')) return clean
  let digits = clean.replace(/[^\d]/g, '')
  if (digits.startsWith('0')) digits = `972${digits.slice(1)}`
  return digits ? `${digits}@s.whatsapp.net` : clean
}

function api(path, options = {}) {
  const request = signal => fetch(path, { ...options, signal: options.signal || signal, headers: options.headers || {} }).then(async response => {
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(data.error || '?????')
      error.status = response.status
      throw error
    }
    return data
  })
  if (options.method && options.method !== 'GET') return request()
  const query = new URL(path, location.origin).searchParams
  return requestPool.run(path, { bot: query.get('bot'), jid: query.get('jid'), path }, request)
}

async function refreshQr(bot) {
  if (!bot?.qr) return
  qrImages.value = {
    ...qrImages.value,
    [bot.id]: await QRCode.toDataURL(bot.qr, { margin: 1, width: 220 })
  }
}

async function setBots(nextBots) {
  bots.value = nextBots
  if (!nextBots.some(bot => bot.id === selectedBot.value)) {
    selectedBot.value = nextBots[0]?.id || ''
  }
  localStorage.setItem('wa-ui-selected-bot', selectedBot.value)
  await Promise.all(nextBots.map(refreshQr))
}

async function refreshBots() {
  if (!authenticated.value) return
  try {
    const data = await api('/api/session')
    await setBots(data.bots || [])
  } catch (err) {
    if ([401, 402, 403].includes(err.status)) logout()
  }
}

async function login() {
  loginError.value = ''
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value })
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'שגיאה')
    authenticated.value = true
    sessionReady = false
    await setBots(data.bots || [])
    connectSocket(handleSocketEvent)
  } catch (err) {
    loginError.value = err.message
  }
}

async function restoreSession() {
  try {
    const data = await api('/api/session')
    authenticated.value = true
    sessionReady = false
    await setBots(data.bots || [])
    connectSocket(handleSocketEvent)
  } catch (err) {
    if ([401, 402, 403].includes(err.status)) {
      authenticated.value = false
      return
    }
    error.value = err.message
  }
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {})
  authenticated.value = false
  requestPool.cancel()
  updateAppBadge(0)
  disconnectSocket()
}

async function refreshAfterReconnect(hasSession = false) {
  let ok = true
  try {
    if (!hasSession) await refreshBots()
    // Load contacts before chats so the contact-name override applies correctly.
    await loadContacts()
    const ok0 = await loadChats()
    ok = ok0
    autoMarkChatRead()
    updateAppBadge(unreadTotal.value)
  } catch (err) {
    ok = false
    error.value = err.message
  }
  // After a crash the server may still be warming up: allow an immediate
  // visibility resync and retry the chat load once shortly after.
  if (!ok) {
    lastVisibilityResync = 0
    setTimeout(() => {
      if (authenticated.value) loadChats()
    }, 2500)
  }
}

async function handleSocketEvent(data) {
  if (!authenticated.value) return
  if (data.type === 'init') {
      // Update bots list without switching the selected bot
      const nextBots = data.bots || []
      bots.value = nextBots
      if (!nextBots.some(bot => bot.id === selectedBot.value)) {
        selectedBot.value = nextBots[0]?.id || ''
      }
      localStorage.setItem('wa-ui-selected-bot', selectedBot.value)
      await Promise.all(nextBots.map(refreshQr))
      // The server does not replay events missed while disconnected.
      await refreshAfterReconnect(true)
      sessionReady = true
    }
    if (data.type === 'connection') {
      // status.id is the WhatsApp account JID; data.bot is the stable API ID.
      // Keep the same ID/accountId contract as the session and init payloads.
      const next = bots.value.map(bot => bot.id === data.bot
        ? { ...bot, ...data.status, id: bot.id, accountId: data.status.id }
        : bot)
      await setBots(next)
      // NOTE: we deliberately do NOT touch lastVisibilityResync here. A bot-status
      // push only carries lightweight counts and does not refresh chat data, and it
      // can arrive for any bot. Resetting the throttle window on every status event
      // would suppress the visibility resync (the only path that actually reloads
      // chats) indefinitely. The throttle is tracked at the actual resync points
      // (onVisibilityChange / refreshAfterReconnect) instead.
    }
    if (data.type === 'account-purged' && data.bot === selectedBot.value) {
      chats.value = []
      messages.value = []
      selectedChat.value = ''
    }
    if (data.type === 'chat-cleared' && data.bot === selectedBot.value) {
      const chat = chats.value.find(item => item.jid === data.jid)
      if (chat) clearChatLocally(chat)
    }
    if (data.type === 'chat-deleted' && data.bot === selectedBot.value) {
      chats.value = chats.value.filter(item => item.jid !== data.jid)
      if (selectedChat.value === data.jid) {
        selectedChat.value = ''
        messages.value = []
      }
    }
    if (data.type === 'chat') {
      if (data.bot === selectedBot.value) {
        upsertChat(data.chat)
      }
    }
    if (data.type === 'chat-merge' && data.bot === selectedBot.value) {
      chats.value = chats.value.filter(chat => chat.jid !== data.fromJid)
      upsertChat(data.chat)
      if (selectedChat.value === data.fromJid) selectedChat.value = data.toJid
    }
    if (data.type === 'message-update' && data.bot === selectedBot.value && data.jid === selectedChat.value) {
      messages.value = messages.value.map(message => message.id === data.id ? mergeMessagePatch(message, data.patch) : message)
    }
    if (data.type === 'message-remove' && data.bot === selectedBot.value && data.jid === selectedChat.value) {
      messages.value = messages.value.filter(message => message.id !== data.id)
      if (editingMessage.value?.id === data.id) closeEdit()
    }
    if (data.type === 'message' && data.bot === selectedBot.value) {
      upsertChat(data.chat)
      if (data.message.jid === selectedChat.value) {
        upsertMessage(data.message)
        if (!data.message.fromMe) autoMarkChatRead(data.message.jid)
        scrollToBottom(data.message)
      }
    }
    if (data.type === 'scheduled' && data.bot === selectedBot.value) {
      // Scheduled list changed (scheduled / sent / cancelled) — refresh the
      // pending bubbles in the thread if it's the open chat.
      if (data.jid === selectedChat.value) loadScheduled()
    }
    if (data.type === 'refresh' && data.bot === selectedBot.value) {
      // Reload contacts first so the contact-name override applies when chats load.
      await loadContacts(true)
      await loadChats()
    }
}

function applyContactName(chat) {
  // Override a personal chat's name with the address-book contact name when known.
  // The server may use WhatsApp profile names (pushName) or a stale cached name;
  // the client contacts list has the authoritative name. Applied on every load
  // path (initial fetch + live events) so wrong names are corrected consistently.
  if (chat && !chat.isGroup && typeof contactsById !== 'undefined' && contactsById?.value) {
    const contact = contactsById.value.get(chat.jid)
    if (contact && contact.name && contact.name !== chat.name) {
      chat.name = contact.name
    }
  }
  return chat
}

function upsertChat(chat) {
  const existing = chatsById.value.get(chat.jid)
  // Preserve typing status if not present in update
  if (existing && chat.typing === undefined) {
    chat.typing = existing.typing
    chat.typingTimestamp = existing.typingTimestamp
  }
  // When currently viewing a chat, don't let incoming events increase unread
  if (existing && chat.jid === selectedChat.value && Number(chat.unread || 0) > Number(existing.unread || 0)) {
    chat.unread = existing.unread
  }
  // Override chat name with contact name from address book when available.
  // The server may use WhatsApp names (pushName) when the contact name isn't
  // synced, but the client-side contacts list has the correct address-book name.
  applyContactName(chat)
  if (existing) Object.assign(existing, chat)
  else chats.value.push(chat)
}

function upsertMessage(message) {
  const index = messages.value.findIndex(item => item.id === message.id)
  if (index >= 0) {
    const next = [...messages.value]
    next[index] = mergeMessagePatch(next[index], message)
    messages.value = next
    return
  }
  messages.value = [...messages.value, message].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
}

// Real messages plus pending "send later" entries, rendered in the thread as
// pending bubbles (clock icon + scheduled time instead of status ticks).
const threadMessages = computed(() => {
  if (!scheduledList.value.length) return messages.value
  const pending = scheduledList.value.map(item => ({
    id: item.id,
    jid: item.jid,
    fromMe: true,
    sender: 'אני',
    text: item.text,
    type: 'conversation',
    timestamp: item.sendAt,
    scheduled: true
  }))
  return [...messages.value, ...pending].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
})

function updateMessage(message) {
  const index = messages.value.findIndex(item => item.id === message.id)
  if (index >= 0) {
    const next = [...messages.value]
    next[index] = { ...next[index], ...message }
    messages.value = next
  }
}

function clearExpiredTyping(jid, typingTimestamp) {
  const chat = chats.value.find(item => item.jid === jid)
  if (!chat?.typing || chat.typingTimestamp !== typingTimestamp) return
  chat.typing = null
  chat.typingTimestamp = undefined
  chats.value = [...chats.value]
}







function activeSendJid() {
  if (currentChat.value?.phoneNumber) return currentChat.value.phoneNumber
  return selectedChat.value
}



























function messageSenderName(message) {
  if (!message) return ''
  return message.fromMe ? 'אני' : message.sender
}
















async function loadChats(retried = false) {
  const bot = selectedBot.value
  if (!bot || !authenticated.value) return true
  const requestId = ++chatLoadRequest
  try {
    error.value = ''
    loadingChats.value = !chats.value.length
    const data = await api(`/api/chats?bot=${encodeURIComponent(bot)}`)
    if (!authenticated.value || selectedBot.value !== bot || requestId !== chatLoadRequest) return true
    const existing = chatsById.value
    chats.value = (data.chats || []).map(chat => {
      // Apply the address-book contact name to personal chats so a wrong/stale
      // server-side name is corrected on every load (not just live events).
      if (chat && !chat.isGroup && typeof contactsById !== 'undefined' && contactsById?.value) {
        const contact = contactsById.value.get(chat.jid)
        if (contact && contact.name && contact.name !== chat.name) chat.name = contact.name
      }
      const current = existing.get(chat.jid)
      return current ? Object.assign(current, chat) : chat
    })
    if (!selectedChat.value && filteredChats.value[0]) await selectChat(filteredChats.value[0].jid)
    return true
  } catch (err) {
    if (!authenticated.value || selectedBot.value !== bot || requestId !== chatLoadRequest) return true
    if (err.status === 404 && !retried) {
      const data = await api('/api/session')
      await setBots(data.bots || [])
      return await loadChats(true)
    }
    // Preserve the current list and thread on transient refresh failures.
    error.value = err.message
    return false
  } finally {
    if (requestId === chatLoadRequest) loadingChats.value = false
  }
}

async function loadContacts(force = false) {
  const bot = selectedBot.value
  if (!bot || !authenticated.value) return
  if (!force && contactsLoadedBot === bot && Date.now() - contactsLoadedAt < 60000) return
  try {
    const data = await api(`/api/contacts?bot=${encodeURIComponent(bot)}`)
    if (!authenticated.value || selectedBot.value !== bot) return
    contacts.value = data.contacts || []
    contactsLoadedBot = bot
    contactsLoadedAt = Date.now()
  } catch (err) {
    // Contacts are optional; retain the address book on transient errors.
  }
}

async function selectChat(jid, contactName) {
  jid = normalizeJid(jid)
  if (!jid) return
  const hadUnread = Number(chats.value.find(chat => chat.jid === jid)?.unread || 0) > 0
  if (selectedChat.value === jid && (loadingMessages.value || messages.value.length)) {
    if (hadUnread) autoMarkChatRead(jid)
    return
  }
  const requestedBot = selectedBot.value
  requestPool.cancel(scope => scope.path.startsWith('/api/messages?') && (scope.bot !== requestedBot || scope.jid !== jid))
  const requestId = ++messageLoadRequest
  const requestedJid = jid
  let shouldSyncFromPhone = false
  selectedChat.value = jid
  // Ensure a chat entry exists so conversation-head shows name/avatar
  if (!chats.value.find(c => c.jid === jid)) {
    const phone = jid.replace(/@s\.whatsapp\.net$/, '')
    const name = contactName || phone
    chats.value = [{ jid, name, phoneNumber: phone, displayJid: phone, timestamp: 0, unread: 0, isGroup: jid.endsWith('@g.us') }, ...chats.value]
  }
  newJid.value = ''
  text.value = loadDraft(requestedBot, jid)
  messages.value = []
  actionMessageId.value = ''
  reactionMessageId.value = ''
  replyTo.value = null
  emojiPanelOpen.value = false
  showAttachMenu.value = false
  showSchedule.value = false
  cancelScheduledEdit()
  groupParticipants.value = []
  selectedMentions.value = []
  mentionQuery.value = null
  loadingMessages.value = true
  // Only clear local unread when auto-mark-read is on. When off, opening
  // a chat should not mark it as read — only phone-originated reads count.
  if (autoMarkRead.value) clearLocalUnread(jid)
  try {
    error.value = ''
    const data = await api(`/api/messages?bot=${encodeURIComponent(requestedBot)}&jid=${encodeURIComponent(jid)}&limit=200`)
    if (selectedBot.value !== requestedBot || selectedChat.value !== requestedJid || requestId !== messageLoadRequest) return
    messages.value = data.messages || []
    loadScheduled()
    shouldSyncFromPhone = messages.value.length === 0
    if (autoMarkRead.value) {
      if (hadUnread) autoMarkChatRead(jid)
    }
    // When auto-mark-read is off, don't clear unread locally and don't send
    // read receipts to the server when opening a chat. Only phone-originated
    // reads (server-side) are accepted.
  } catch (err) {
    if (selectedBot.value !== requestedBot || selectedChat.value !== requestedJid || requestId !== messageLoadRequest) return
    messages.value = []
    error.value = err.message
  } finally {
    if (selectedBot.value === requestedBot && selectedChat.value === requestedJid && requestId === messageLoadRequest) {
      loadingMessages.value = false
      // Chat just opened — always jump to the latest message regardless of
      // where the previous chat left the scroll position.
      forceScrollToBottom()
    }
  }
  if (currentChat.value?.isGroup) loadGroupParticipants(requestedBot, requestedJid)
  if (
    shouldSyncFromPhone
    && selectedBot.value === requestedBot
    && selectedChat.value === requestedJid
    && requestId === messageLoadRequest
  ) {
    await loadOlderMessages()
  }
}

async function loadGroupParticipants(bot = selectedBot.value, jid = selectedChat.value) {
  try {
    const data = await api(`/api/group-participants?bot=${encodeURIComponent(bot)}&jid=${encodeURIComponent(jid)}`)
    if (selectedBot.value === bot && selectedChat.value === jid) groupParticipants.value = data.participants || []
  } catch {
    if (selectedBot.value === bot && selectedChat.value === jid) groupParticipants.value = []
  }
}

async function leaveGroup() {
  const jid = selectedChat.value
  if (!jid || !selectedBot.value) return
  try {
    await api('/api/group-leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: selectedBot.value, jid })
    })
    showChatInfo.value = false
    selectedChat.value = ''
    messages.value = []
    groupParticipants.value = []
    await loadChats()
  } catch (err) {
    error.value = err.message
  }
}

async function markAllRead() {
  if (!selectedBot.value || !authenticated.value) return
  try {
    await api('/api/mark-all-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: selectedBot.value })
    })
    for (const chat of chats.value) chat.unread = 0
  } catch (err) {
    error.value = err.message
  }
}

// Open the selected conversation's full-resolution avatar in a new tab.
// Only when the small avatar actually rendered as an image (no 404 / non-image).
function openChatAvatar() {
  if (!selectedChat.value || !selectedBot.value || !avatarLoaded.value) return
  const url = `/api/avatar?size=large&v=${AVATAR_VERSION}&bot=${encodeURIComponent(selectedBot.value)}&jid=${encodeURIComponent(selectedChat.value)}`
  window.open(url, '_blank', 'noopener')
}

function clearLocalUnread(jid = selectedChat.value) {
  const chat = chats.value.find(item => item.jid === jid)
  if (chat) chat.unread = 0
}
async function markChatLocalRead(jid = selectedChat.value) {
  if (!jid || !selectedBot.value || !authenticated.value) return
  clearLocalUnread(jid)
  try {
    await api('/api/local-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: selectedBot.value, jid })
    })
  } catch (err) {
    error.value = err.message
  }
}

async function markChatRead(jid = selectedChat.value) {
  if (!jid || !selectedBot.value || !authenticated.value) return
  const requestKey = `${selectedBot.value}:${jid}`
  if (markingRead.has(requestKey)) return
  markingRead.add(requestKey)
  try {
    await api('/api/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: selectedBot.value, jid })
    })
    clearLocalUnread(jid)
  } catch (err) {
    error.value = err.message
  } finally {
    markingRead.delete(requestKey)
  }
}

async function toggleArchiveChat(jid, archive) {
  if (!jid || !selectedBot.value || !authenticated.value) return
  try {
    await api('/api/chat-archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: selectedBot.value, jid, archive })
    })
    // Update local chat state
    const chat = chats.value.find(c => c.jid === jid)
    if (chat) chat.isArchived = archive
  } catch (err) {
    error.value = err.message
  }
}

async function clearChatContent(jid) {
  if (!jid || !selectedBot.value || !authenticated.value) return
  const bot = selectedBot.value
  const chat = chats.value.find(c => c.jid === jid)
  const label = chat?.isGroup ? 'קבוצה' : 'שיחה'
  if (!window.confirm(`לנקות את תוכן ה${label}? הפעולה תמחק את ההודעות גם מהמכשיר.`)) return
  try {
    await api('/api/chat-clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot, jid, scope: 'both' })
    })
    // Ignore the result if the user switched accounts while the request was in flight.
    if (bot !== selectedBot.value) return
    // Apply the clear locally as well (covers when the socket event is missed).
    const target = chats.value.find(c => c.jid === jid)
    clearChatLocally(target)
  } catch (err) {
    error.value = err.message
  }
}

function clearChatLocally(chat) {
  if (!chat) return
  chat.lastMessage = ''
  if (chat.jid === selectedChat.value) messages.value = []
}

async function clearAllArchived() {
  if (!selectedBot.value || !authenticated.value) return
  if (!archivedCount.value) return
  const bot = selectedBot.value
  if (!window.confirm(`לנקות את כל השיחות בארכיון (${archivedCount.value})? הפעולה תמחק את ההודעות גם מהמכשיר.`)) return
  try {
    const result = await api('/api/archive-clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot, scope: 'both' })
    })
    // Ignore the result if the user switched accounts while the request was in flight.
    if (bot !== selectedBot.value) return
    // Only clear the chats that actually succeeded on the server.
    const clearedJids = new Set(
      (result?.results || []).filter(item => item.ok).map(item => item.jid)
    )
    if (clearedJids.size) {
      for (const chat of chats.value) {
        if (clearedJids.has(chat.jid)) chat.lastMessage = ''
      }
      if (currentChat.value && clearedJids.has(currentChat.value.jid)) messages.value = []
    }
    const failed = result?.failed || 0
    error.value = failed ? `לא ניתן היה לנקות ${failed} שיחות בארכיון` : ''
  } catch (err) {
    error.value = err.message
  }
}

async function toggleMuteChat(jid, muted) {
  if (!jid || !selectedBot.value || !authenticated.value) return
  try {
    await api('/api/chat-mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: selectedBot.value, jid, muted })
    })
    // Update local chat state
    const chat = chats.value.find(c => c.jid === jid)
    if (chat) chat.isMuted = muted
  } catch (err) {
    error.value = err.message
  }
}

function autoMarkChatRead(jid = selectedChat.value) {
  if (!autoMarkRead.value || document.visibilityState !== 'visible' || jid !== selectedChat.value) return
  markChatRead(jid)
}

function onVisibilityChange() {
  if (document.visibilityState !== 'visible' || !authenticated.value) return
  updateAppBadge(unreadTotal.value)
  if (isClosed()) {
    connectSocket(handleSocketEvent)
    return
  }
  if (!isOpen()) return
  // Throttle the full resync to once per 20s — the socket already pushes
  // bot status (unread counts), this covers events missed while frozen.
  if (Date.now() - lastVisibilityResync < 20000) return
  lastVisibilityResync = Date.now()
  refreshAfterReconnect()
}

async function loadOlderMessages() {
  if (!selectedChat.value || loadingOlder.value) return
  const bot = selectedBot.value
  const jid = selectedChat.value
  const oldest = messages.value[0]
  const isCurrentChat = () => selectedBot.value === bot && selectedChat.value === jid
  loadingOlder.value = true
  error.value = ''
  try {
    if (oldest?.timestamp) {
      const cached = await api(`/api/messages?bot=${encodeURIComponent(bot)}&jid=${encodeURIComponent(jid)}&before=${oldest.timestamp}&limit=100`)
      if (!isCurrentChat()) return
      if (cached.messages?.length) {
        const known = new Set(messages.value.map(message => message.id))
        messages.value = [...cached.messages.filter(message => !known.has(message.id)), ...messages.value]
        return
      }
    }

    const synced = await api('/api/sync-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot, jid, count: 50 })
    })
    if (!isCurrentChat()) return
    if (synced.messages?.length) {
      const known = new Set(messages.value.map(message => message.id))
      messages.value = [...synced.messages.filter(message => !known.has(message.id)), ...messages.value]
      // Initial sync (no prior messages) — always jump to latest.
      if (!oldest) forceScrollToBottom()
      return
    }
    const deadline = Date.now() + 120000
    while (Date.now() < deadline && isCurrentChat()) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      const before = oldest?.timestamp ? `&before=${oldest.timestamp}` : ''
      const data = await api(`/api/messages?bot=${encodeURIComponent(bot)}&jid=${encodeURIComponent(jid)}${before}&limit=100`)
      if (!isCurrentChat()) return
      if (data.messages?.length) {
        const known = new Set(messages.value.map(message => message.id))
        messages.value = [...data.messages.filter(message => !known.has(message.id)), ...messages.value]
        // Initial sync (no prior messages) — always jump to latest.
        if (!oldest) forceScrollToBottom()
        return
      }
    }
    if (isCurrentChat()) error.value = 'נשלחה בקשה לטלפון, עדיין אין הודעות חדשות'
  } catch (err) {
    if (isCurrentChat()) error.value = err.message
  } finally {
    loadingOlder.value = false
  }
}

function openNewChat() {
  const jid = normalizeJid(newJid.value)
  if (!jid) return
  selectedChat.value = jid
  text.value = loadDraft(selectedBot.value, jid)
  messages.value = []
  actionMessageId.value = ''
  reactionMessageId.value = ''
  replyTo.value = null
  emojiPanelOpen.value = false
}

async function onMentionClick(jid) {
  // JID is already a clean phone number from server-side @[phone|name] resolution.
  // For plain @mentions (old messages), normalize directly.
  const resolved = normalizeJid(jid)
  if (!resolved) return
  selectedChat.value = resolved
  newJid.value = ''
  text.value = loadDraft(selectedBot.value, resolved)
  messages.value = []
  actionMessageId.value = ''
  reactionMessageId.value = ''
  replyTo.value = null
  emojiPanelOpen.value = false
}

function onThreadClick() {
  if (selectedChat.value && autoMarkRead.value && Number(currentChat.value?.unread || 0) > 0) {
    markChatRead(selectedChat.value)
  }
}

async function saveEdit(nextText) {
  const target = editingMessage.value
  if (!target?.id || editBusy.value || !nextText) return
  const bot = selectedBot.value
  const outgoingChat = target.jid || selectedChat.value
  editBusy.value = true
  editError.value = ''
  try {
    const data = await api('/api/edit-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot, jid: outgoingChat, id: target.id, text: nextText })
    })
    // Only reflect the result on the currently visible thread; the server also
    // emits message-update for every client.
    if (selectedBot.value === bot && selectedChat.value === outgoingChat && data.message) updateMessage(data.message)
    if (editingMessage.value?.id === target.id) closeEdit()
  } catch (err) {
    editError.value = err.message
  } finally {
    editBusy.value = false
  }
}

async function sendText() {
  if (!selectedChat.value || !text.value.trim() || showUploadModal.value || isReadOnly.value) return
  replaceTextEmojis()
  const outgoingText = text.value.trim()
  const outgoingJid = activeSendJid()
  const outgoingChat = selectedChat.value
  const outgoingBot = selectedBot.value
  const outgoingReplyId = replyTo.value?.id || ''
  const outgoingReplyJid = replyTo.value?.jid || ''
  const outgoingMentions = selectedMentions.value
    .filter(mention => outgoingText.includes(`@${participantMentionToken(mention)}`))
    .map(mention => mention.jid)
  text.value = ''
  selectedMentions.value = []
  mentionQuery.value = null
  replyTo.value = null
  emojiPanelOpen.value = false
  composerLinkPreview.value = null
  saveDraft('', outgoingBot, outgoingChat)
  error.value = ''
  try {
    const data = await api('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: outgoingBot, jid: outgoingJid, text: outgoingText, quotedId: outgoingReplyId, quotedJid: outgoingReplyJid, mentions: outgoingMentions })
    })
    if (data.message && selectedChat.value === outgoingChat) {
      upsertMessage(data.message)
      scrollToBottom(data.message)
    }
  } catch (err) {
    error.value = err.message
  }
}

async function sendButtonReply(payload) {
  const { jid, text, buttonId, selectedIndex, messageId } = payload
  const bot = selectedBot.value
  if (!bot || !jid || !text) return
  error.value = ''
  try {
    const data = await api('/api/send-button-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot, jid, text, buttonId, selectedIndex, quotedId: messageId })
    })
    if (data.message) {
      upsertMessage(data.message)
      scrollToBottom(data.message)
    }
  } catch (err) {
    error.value = err.message
  }
}

async function loadComposerLinkPreview(value) {
  const requestId = ++linkPreviewRequest
  composerLinkPreview.value = null
  loadingLinkPreview.value = true
  try {
    const data = await api('/api/link-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: selectedBot.value, text: value })
    })
    if (requestId === linkPreviewRequest && text.value.trim() === value) {
      composerLinkPreview.value = data.preview || null
    }
  } catch {
    if (requestId === linkPreviewRequest) composerLinkPreview.value = null
  } finally {
    if (requestId === linkPreviewRequest) loadingLinkPreview.value = false
  }
}

function toggleMessageMenu(message) {
  if (loadingMessages.value) return
  actionMessageId.value = actionMessageId.value === message.id ? '' : message.id
  reactionMessageId.value = ''
}

// Hover-driven open/close of the message menu (⋯ button and the menu itself).
function setMessageMenu(message) {
  if (loadingMessages.value) return
  if (!message) {
    actionMessageId.value = ''
    reactionMessageId.value = ''
    return
  }
  actionMessageId.value = message.id
  if (reactionMessageId.value && reactionMessageId.value !== message.id) reactionMessageId.value = ''
}

// Hover-driven open of the emoji picker (אמוג'י button inside the menu).
function setReactionMenu(message) {
  if (loadingMessages.value) return
  actionMessageId.value = message.id
  reactionMessageId.value = message.id
}

async function sendContact(contact) {
  if (!selectedChat.value || !contact) return
  const outgoingJid = activeSendJid()
  const outgoingChat = selectedChat.value
  const outgoingBot = selectedBot.value
  actionMessageId.value = ''
  showContactPicker.value = false
  error.value = ''
  try {
    const vcard = makeVcard(contact)
    if (!vcard) { error.value = 'איש קשר חייב שם ומספר טלפון'; return }
    const data = await api('/api/send-contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: outgoingBot, jid: outgoingJid, displayName: contact.name, vcard })
    })
    if (data.message && selectedBot.value === outgoingBot && selectedChat.value === outgoingChat) {
      upsertMessage(data.message)
      scrollToBottom(data.message)
    }
  } catch (err) {
    error.value = err.message
  }
}

function openContactPicker() {
  showContactPicker.value = true
  actionMessageId.value = ''
}

function closeContactPicker() {
  showContactPicker.value = false
}

// Generate a WhatsApp-native vCard for a contact client-side.
function makeVcard(contact) {
  return buildContactVcard(contact.name, contact.phoneNumber)
}

async function forwardMessage(sourceJid, sourceId, targetJid) {
  if (!sourceJid || !sourceId || !targetJid) return
  actionMessageId.value = ''
  showForwardPopup.value = false
  error.value = ''
  try {
    const data = await api('/api/forward-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: selectedBot.value, sourceJid, sourceId, targetJid })
    })
    if (data.message && selectedChat.value === targetJid) {
      upsertMessage(data.message)
      scrollToBottom(data.message)
    }
  } catch (err) {
    error.value = err.message
  }
}

function openForwardPopup(message) {
  forwardMessageId.value = message.id
  forwardSourceJid.value = message.jid || selectedChat.value
  showForwardPopup.value = true
  actionMessageId.value = ''
}

function closeForwardPopup() {
  showForwardPopup.value = false
  forwardMessageId.value = ''
  forwardSourceJid.value = ''
  forwardTargetJid.value = ''
}

function selectForwardTarget(jid) {
  forwardTargetJid.value = jid
  forwardMessage(forwardSourceJid.value, forwardMessageId.value, jid)
}


function startEdit(message) {
  if (!message?.id || !isMessageEditable(message)) return
  editingMessage.value = message
  editError.value = ''
  actionMessageId.value = ''
  reactionMessageId.value = ''
  emojiPanelOpen.value = false
}

function closeEdit() {
  editingMessage.value = null
  editError.value = ''
  editBusy.value = false
}

// Editing targets a single message, so dropping it on chat switch is safest.
watch(selectedChat, () => {
  closeEdit()
})

function replyMessage(message) {
  closeEdit()
  replyTo.value = message
  actionMessageId.value = ''
  reactionMessageId.value = ''
  if (!message.fromMe && autoMarkRead.value) markChatRead(message.jid || selectedChat.value)
  nextTick(() => textAreaRef.value?.focus())
}

function replyFromThreadDoubleClick(message) {
  if (!selectedChat.value || loadingMessages.value || !message) return
  replyMessage(message)
}

function cancelReply() {
  replyTo.value = null
}

async function replyPrivate(message) {
  if (!message || message.fromMe) return
  // Get the sender's phone number from the message
  const number = String(message.senderNumber || '').replace(/[^\d]/g, '')
  if (!number || String(message.senderNumber || '').includes('@lid')) {
    // Fallback: try finding the sender's chat in the chats list
    const participant = message.key?.participant || ''
    const matched = chats.value.find(c => c.jid === participant || c.displayJid === participant || c.phoneNumber?.includes(participant.replace(/[^\d]/g, '')))
    if (matched) {
      actionMessageId.value = ''
      reactionMessageId.value = ''
      await selectChat(matched.jid)
      replyTo.value = message
    }
    return
  }
  const jid = `${number}@s.whatsapp.net`
  actionMessageId.value = ''
  reactionMessageId.value = ''
  await selectChat(jid)
  replyTo.value = message
}

async function deleteMessage(message, options = {}) {
  if (!selectedChat.value || !message?.id) return
  const local = Boolean(options.local)
  // An already-revoked message cannot be revoked again, but it can still be
  // removed locally (that is how a "הודעה נמחקה" placeholder goes away).
  if (message.deleted && !local) return
  actionMessageId.value = ''
  reactionMessageId.value = ''
  error.value = ''
  const chatJid = message.jid || selectedChat.value
  try {
    const data = await api('/api/delete-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: selectedBot.value, jid: chatJid, id: message.id, local })
    })
    if (selectedChat.value === chatJid) {
      // Remote delete keeps a tombstone; a local delete removes it entirely.
      if (data.patch) messages.value = messages.value.map(item => item.id === message.id ? mergeMessagePatch(item, data.patch) : item)
      else messages.value = messages.value.filter(item => item.id !== message.id)
    }
    if (editingMessage.value?.id === message.id) closeEdit()
  } catch (err) {
    error.value = err.message
  }
}

async function reactToMessage(message, emoji) {
  if (!selectedChat.value || !message?.id) return
  reactionMessageId.value = ''
  actionMessageId.value = ''
  // Tapping my own reaction removes it: an empty react text is the WhatsApp
  // protocol for taking a reaction back.
  const mine = Array.isArray(message.reactions)
    && message.reactions.some(item => item?.text === emoji && (item.userJid === 'me' || item.sender === 'אני'))
  const outgoing = mine ? '' : emoji
  if (emoji && !mine) {
    usedEmojis.value = [emoji, ...usedEmojis.value.filter(item => item !== emoji)].slice(0, 24)
    localStorage.setItem('wa-ui-used-emojis', JSON.stringify(usedEmojis.value))
  }
  error.value = ''
  try {
    const data = await api('/api/react-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: selectedBot.value, jid: message.jid || selectedChat.value, id: message.id, emoji: outgoing })
    })
    messages.value = messages.value.map(item => item.id === message.id ? mergeMessagePatch(item, data.patch || {}) : item)
  } catch (err) {
    error.value = err.message
  }
}

function toggleEmojiPanel() {
  emojiPanelOpen.value = !emojiPanelOpen.value
  showSchedule.value = false
}

function insertComposerText(value) {
  const el = textAreaRef.value
  const start = el?.selectionStart ?? text.value.length
  const end = el?.selectionEnd ?? text.value.length
  text.value = `${text.value.slice(0, start)}${value}${text.value.slice(end)}`
  nextTick(() => {
    textAreaRef.value?.focus()
    const cursor = start + value.length
    textAreaRef.value?.setSelectionRange(cursor, cursor)
  })
}

function updateMentionQuery() {
  const cursor = textAreaRef.value?.selectionStart ?? text.value.length
  const match = text.value.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/)
  mentionQuery.value = currentChat.value?.isGroup && match ? match[1] : null
  mentionIndex.value = 0
}

function insertMention(participant) {
  const el = textAreaRef.value
  const cursor = el?.selectionStart ?? text.value.length
  const before = text.value.slice(0, cursor)
  const match = before.match(/(?:^|\s)@([^\s@]*)$/)
  if (!match) return
  const token = participantMentionToken(participant)
  if (!token) return
  const start = cursor - match[1].length - 1
  const value = `@${token} `
  text.value = `${text.value.slice(0, start)}${value}${text.value.slice(cursor)}`
  selectedMentions.value = [...selectedMentions.value.filter(mention => mention.jid !== participant.jid), participant]
  mentionQuery.value = null
  nextTick(() => {
    el?.focus()
    el?.setSelectionRange(start + value.length, start + value.length)
  })
}

function onComposerKeydown(event) {
  if (mentionSuggestions.value.length) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      mentionIndex.value = (mentionIndex.value + direction + mentionSuggestions.value.length) % mentionSuggestions.value.length
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      insertMention(mentionSuggestions.value[mentionIndex.value])
      return
    }
    if (event.key === 'Escape') {
      mentionQuery.value = null
      return
    }
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendText()
  }
}

function replaceTextEmojis() {
  const next = text.value.replace(textEmojiPattern, (_match, prefix, code) => `${prefix}${textEmojiMap[code]}`)
  if (next === text.value) return
  const oldLength = text.value.length
  const cursor = textAreaRef.value?.selectionStart ?? next.length
  text.value = next
  nextTick(() => {
    const nextCursor = Math.max(0, cursor + (next.length - oldLength))
    textAreaRef.value?.setSelectionRange(nextCursor, nextCursor)
  })
}

function insertEmoji(emoji) {
  insertComposerText(emoji)
  usedEmojis.value = [emoji, ...usedEmojis.value.filter(item => item !== emoji)].slice(0, 24)
  localStorage.setItem('wa-ui-used-emojis', JSON.stringify(usedEmojis.value))
  emojiPanelOpen.value = false
}

// -------- Attach submenu (file / contact) --------

const showAttachMenu = ref(false)
const attachMenuRef = ref(null)

function toggleAttachMenu() {
  showAttachMenu.value = !showAttachMenu.value
  emojiPanelOpen.value = false
  showSchedule.value = false
}

function attachFile() {
  showAttachMenu.value = false
  openUploadPicker()
}

function attachContact() {
  showAttachMenu.value = false
  openContactPicker()
}

onClickOutside(attachMenuRef, () => {
  if (showAttachMenu.value) showAttachMenu.value = false
})

// -------- Send later (scheduled messages) --------

const showSchedule = ref(false)
const scheduleAt = ref('')
const scheduledList = ref([])
const scheduling = ref(false)
// Editing an existing pending message (set while the form edits that item)
const editingScheduledId = ref('')
const scheduledEditText = ref('')
const schedulePanelRef = ref(null)
const scheduleTriggerRef = ref(null)

// Close the schedule popup when clicking anywhere outside it (the arrow
// trigger is excluded — it toggles on its own click)
onClickOutside(schedulePanelRef, () => {
  if (showSchedule.value) {
    showSchedule.value = false
    cancelScheduledEdit()
  }
}, { ignore: [scheduleTriggerRef] })

function toLocalInputValue(date) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toggleSchedule() {
  showSchedule.value = !showSchedule.value
  emojiPanelOpen.value = false
  showAttachMenu.value = false
  if (showSchedule.value) {
    scheduleAt.value = toLocalInputValue(new Date(Date.now() + 3600_000))
    loadScheduled()
  } else {
    cancelScheduledEdit()
  }
}

function startScheduledEdit(item) {
  editingScheduledId.value = item.id
  scheduledEditText.value = item.text
  scheduleAt.value = toLocalInputValue(new Date(item.sendAt))
  showSchedule.value = true
  emojiPanelOpen.value = false
  loadScheduled()
}

function cancelScheduledEdit() {
  editingScheduledId.value = ''
  scheduledEditText.value = ''
}

// Click on a pending bubble in the thread — open the panel editing it
function onEditScheduled(id) {
  const item = scheduledList.value.find(entry => entry.id === id)
  if (item) startScheduledEdit(item)
}

async function loadScheduled() {
  if (!selectedChat.value) return
  try {
    const params = new URLSearchParams({ bot: selectedBot.value, jid: selectedChat.value })
    const data = await api(`/api/scheduled-messages?${params}`)
    scheduledList.value = data.messages || []
    if (editingScheduledId.value && !scheduledList.value.some(entry => entry.id === editingScheduledId.value)) cancelScheduledEdit()
  } catch {
    scheduledList.value = []
  }
}

async function scheduleMessage() {
  if (!selectedChat.value || scheduling.value) return
  const sendAt = scheduleAt.value ? new Date(scheduleAt.value).getTime() : 0
  const editing = Boolean(editingScheduledId.value)
  const bodyText = editing ? scheduledEditText.value.trim() : text.value.trim()
  if (!bodyText) {
    Toast.warning(editing ? 'כתבו טקסט להודעה' : 'כתבו הודעה לתיבת הטקסט קודם')
    return
  }
  if (!sendAt || sendAt <= Date.now()) {
    Toast.warning('בחרו זמן עתידי')
    return
  }
  scheduling.value = true
  try {
    if (editing) {
      await api('/api/scheduled-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot: selectedBot.value, id: editingScheduledId.value, text: bodyText, sendAt })
      })
      cancelScheduledEdit()
      Toast.success('ההודעה המתוזמנת עודכנה')
    } else {
      await api('/api/schedule-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot: selectedBot.value, jid: selectedChat.value, text: bodyText, sendAt })
      })
      text.value = ''
      Toast.success('ההודעה תישלח בזמן שנבחר')
    }
    loadScheduled()
  } catch (err) {
    Toast.error(err.message)
  } finally {
    scheduling.value = false
  }
}

async function cancelScheduled(item) {
  try {
    await api('/api/scheduled-cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: selectedBot.value, id: item.id })
    })
    scheduledList.value = scheduledList.value.filter(entry => entry.id !== item.id)
    if (editingScheduledId.value === item.id) cancelScheduledEdit()
  } catch (err) {
    Toast.error(err.message)
  }
}

// Called by the UploadModal when the user confirms sending the staged files.
async function onFilesSend({ files, caption: captionText, forwarded }) {
  if (busy.value || !selectedChat.value || !files?.length) return
  const jid = activeSendJid()
  const bot = selectedBot.value
  busy.value = true
  error.value = ''
  // Close the modal immediately and move the wait indicator into the main
  // window: an uploading strip in the composer replaces the modal while the
  // upload runs, so the thread stays visible and interactive.
  showUploadModal.value = false
  uploadingFile.value = { name: files[0].name || 'קובץ', index: 1, total: files.length }
  if (files[0].type?.startsWith('image/')) setUploadingPreviewBlob(files[0])
  // The composer text was consumed as the caption of the first file
  text.value = ''
  const remaining = [...files]
  try {
    while (remaining.length) {
      const file = remaining[0]
      const form = new FormData()
      form.append('bot', bot)
      form.append('jid', jid)
      // Only the first file carries the caption
      form.append('caption', remaining.length === files.length ? captionText : '')
      form.append('forwarded', String(forwarded))
      form.append('file', file)
      const data = await api('/api/send-file', { method: 'POST', body: form })
      if (data.message?.jid === selectedChat.value) {
        upsertMessage(data.message)
        scrollToBottom(data.message)
      }
      remaining.shift()
      if (remaining.length) {
        uploadingFile.value = { name: remaining[0].name || 'קובץ', index: files.length - remaining.length + 1, total: files.length }
        if (remaining[0].type?.startsWith('image/')) setUploadingPreviewBlob(remaining[0])
      }
    }
    Toast.success(files.length > 1 ? `${files.length} קבצים נשלחו` : 'הקובץ נשלח')
  } catch (err) {
    error.value = err.message
    // Send failed — restore the modal with the files that were not sent yet
    if (remaining.length) {
      uploadModalRef.value?.openFiles(remaining, forwarded, remaining.length === files.length ? captionText : '')
      showUploadModal.value = true
    }
  } finally {
    uploadingFile.value = null
    clearUploadingPreviewBlob()
    busy.value = false
  }
}

function onFile(event) {
  const files = [...(event.target.files || [])]
  if (files.length) openUploadModal(files)
}

function showDragOverlay(event) {
  if (event?.dataTransfer && ![...event.dataTransfer.types].includes('Files')) return
  draggingFile.value = true
  clearTimeout(dragHideTimer)
  dragHideTimer = setTimeout(() => {
    draggingFile.value = false
  }, 5000)
}

function hideDragOverlay() {
  clearTimeout(dragHideTimer)
  draggingFile.value = false
}

function onDropFile(event) {
  hideDragOverlay()
  if (isReadOnly.value) {
    error.value = 'הקבוצה לקריאה בלבד — רק מנהלים יכולים לשלוח הודעות'
    return
  }
  const files = [...(event.dataTransfer?.files || [])]
  if (files.length) openUploadModal(files)
}

function canDropFileOnChat(event) {
  const types = [...(event.dataTransfer?.types || [])]
  return types.includes('Files') || types.includes('application/x-whatsapp-media') || types.includes('application/x-whatsapp-forward')
}

function onChatDragOver(event, jid) {
  if (!canDropFileOnChat(event)) return
  event.preventDefault()
  event.stopPropagation()
  chatDropJid.value = jid
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function onChatDragLeave(event, jid) {
  if (chatDropJid.value !== jid || event.currentTarget.contains(event.relatedTarget)) return
  chatDropJid.value = ''
}

async function onChatDrop(event, jid) {
  if (!canDropFileOnChat(event)) return
  event.preventDefault()
  event.stopPropagation()
  chatDropJid.value = ''
  hideDragOverlay()

  try {
    // Handle forward drag (text message or media)
    const forwardRaw = event.dataTransfer?.getData('application/x-whatsapp-forward')
    if (forwardRaw) {
      const source = JSON.parse(forwardRaw)
      if (source?.bot && source?.jid && source?.id) {
        await selectChat(jid)
        await forwardMessage(source.jid, source.id, jid)
        return
      }
    }

    let file = event.dataTransfer?.files?.[0]
    let forwarded = false
    if (!file) {
      const raw = event.dataTransfer?.getData('application/x-whatsapp-media')
      const source = raw ? JSON.parse(raw) : null
      if (!source?.bot || !source?.jid || !source?.id) return
      forwarded = true
      const query = new URLSearchParams({ bot: source.bot, jid: source.jid, id: source.id })
      const response = await fetch(`/api/media?${query}`)
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Unable to load file')
      }
      const blob = await response.blob()
      file = new File([blob], source.fileName || source.id, {
        type: blob.type || source.mimeType || 'application/octet-stream'
      })
    }

    await selectChat(jid)
    openUploadModal(file, forwarded)
  } catch (err) {
    error.value = err.message
  }
}

function onPasteFile(event) {
  if (!selectedChat.value) return
  const files = [...(event.clipboardData?.files || [])]
  if (!files.length) return
  event.preventDefault()
  openUploadModal(files)
}

function openUploadPicker() {
  if (!selectedChat.value) return
  fileInputRef.value?.click()
}

// Accepts a single File or an array of Files
function openUploadModal(file, forwarded = false) {
  if (!selectedChat.value) return
  const files = Array.isArray(file) ? file : (file ? [file] : [])
  // Pre-fill the caption with the current text from the composer input
  uploadModalRef.value?.openFiles(files, forwarded, text.value)
  showUploadModal.value = true
}

function closeUploadModal() {
  showUploadModal.value = false
}

function onKeydown(event) {
  // The edit popup owns Escape while it is open.
  if (event.key === 'Escape' && editingMessage.value) { closeEdit(); return }
  if (event.key === 'Escape' && showUploadModal.value) closeUploadModal()
  if (event.key === 'Escape') {
    actionMessageId.value = ''
    reactionMessageId.value = ''
    replyTo.value = null
    emojiPanelOpen.value = false
    showAttachMenu.value = false
    showSchedule.value = false
    showMenu.value = false
    cancelScheduledEdit()
  }
  const target = event.target
  const isEditing = target?.matches?.('input, textarea, select, [contenteditable="true"]')
  // Delete the targeted message (hovered, or with its action menu open):
  // Delete = for everyone (remote), Shift+Delete = for me (local only).
  const deleteTargetId = actionMessageId.value || hoveredMessageId.value
  // The composer usually holds focus, so don't gate on `isEditing` when the
  // message menu is open or Shift is held: Shift+Delete is always a local
  // message delete, plain Delete only fires when not typing.
  if (event.key === 'Delete' && deleteTargetId && (actionMessageId.value || !isEditing || event.shiftKey)) {
    const message = messages.value.find(item => item.id === deleteTargetId)
    // Plain Delete is a remote revoke (meaningless on a deleted message);
    // Shift+Delete is a local removal and works on tombstones too.
    if (message && (event.shiftKey || !message.deleted)) {
      event.preventDefault()
      deleteMessage(message, { local: event.shiftKey })
      return
    }
  }
  // If the user has an active (non-collapsed) text selection in the thread,
  // don't hijack keystrokes: typing here would collapse the selection and the
  // Ctrl+C (browser copy) would then have nothing to copy. Let default
  // behavior run so selecting + copying a message works normally.
  const selection = window.getSelection()
  const hasTextSelection = Boolean(selection && !selection.isCollapsed && selection.toString())
  if (!isEditing && !hasTextSelection && selectedChat.value && !showUploadModal.value && !event.ctrlKey && !event.metaKey && !event.altKey && event.key?.length === 1) {
    event.preventDefault()
    insertComposerText(event.key)
    if (event.key === ' ') nextTick(replaceTextEmojis)
  }
}

function scrollToBottom(message) {
  nextTick(() => {
    if (threadRef.value) threadRef.value.scrollToBottom(message)
  })
}

// Force a jump to the latest message ignoring the user's current scroll
// position. Used when opening a chat or for the initial message sync.
function forceScrollToBottom() {
  nextTick(() => {
    if (threadRef.value) threadRef.value.forceScrollToBottom()
  })
}

function scrollToMessage(id) {
  if (!id || !threadRef.value) return
  threadRef.value?.scrollToMessage?.(id)
}

// Date caption logic is inline in the template

function updateAppBadge(count) {
  document.title = count ? `(${count}) WhatsApp` : 'WhatsApp'
  updateFaviconBadge(count)
  try {
    const result = count > 0
      ? navigator.setAppBadge?.(count)
      : navigator.clearAppBadge ? navigator.clearAppBadge() : navigator.setAppBadge?.(0)
    result?.catch(err => console.warn('Unable to update app badge:', err))
  } catch (err) {
    console.warn('Unable to update app badge:', err)
  }
}

/** Generate a favicon SVG data URL with a red badge overlay showing the unread count.
 *  Uses inline SVG markup so it works in all browsers without canvas/image loading issues.
 */
/** Generate a favicon PNG (canvas-drawn) with a red badge overlay showing the
 *  unread count. Drawn at 64px so the badge stays readable at 16px tab size;
 *  the base /favicon.svg is rasterized once and reused. */
let faviconBaseImage = null

function loadFaviconBase() {
  return new Promise(resolve => {
    if (faviconBaseImage) return resolve(faviconBaseImage)
    const img = new Image()
    img.onload = () => { faviconBaseImage = img; resolve(img) }
    img.onerror = () => resolve(null)
    img.src = '/favicon.svg'
  })
}

// The favicon <link> lives in index.html's <head> (outside the Vue tree), so
// it cannot be a template ref — resolve it once and cache it.
let faviconLink = null

async function updateFaviconBadge(count) {
  faviconLink ||= document.querySelector('link[rel="icon"]')
  const link = faviconLink
  if (!link) return
  const img = await loadFaviconBase()
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (img) {
    ctx.drawImage(img, 0, 0, 64, 64)
  } else {
    // Fallback base if the SVG could not be rasterized
    ctx.fillStyle = '#166a5b'
    ctx.beginPath()
    ctx.roundRect(0, 0, 64, 64, 14)
    ctx.fill()
  }
  if (count > 0) {
    ctx.fillStyle = '#e53935'
    ctx.beginPath()
    ctx.arc(48, 48, 16, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2.5
    ctx.stroke()
    const text = count > 99 ? '99+' : String(count)
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${text.length > 2 ? 13 : 17}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 48, 49)
  }
  link.setAttribute('href', canvas.toDataURL('image/png'))
}

watch(selectedChat, (jid) => { avatarLoaded.value = avatarCache[jid] === true })

watch(selectedBot, async (val, oldVal) => {
  requestPool.cancel(scope => Boolean(scope.bot) && scope.bot !== val)
  contacts.value = []
  contactsLoadedBot = ''
  if (val) localStorage.setItem('wa-ui-selected-bot', val)
  messageLoadRequest += 1
  selectedChat.value = ''
  chats.value = []
  messages.value = []
  text.value = ''
  actionMessageId.value = ''
  reactionMessageId.value = ''
  replyTo.value = null
  emojiPanelOpen.value = false
  if (!sessionReady) return
  try {
    await loadContacts()
    await loadChats()
  } catch (err) {
    error.value = err.message
  }
})

watch(text, value => {
  saveDraft(value)
  clearTimeout(linkPreviewTimer)
  linkPreviewRequest += 1
  composerLinkPreview.value = null
  loadingLinkPreview.value = false
  const trimmed = value.trim()
  if (!hasLinkCandidate(trimmed) || !selectedBot.value) return
  linkPreviewTimer = setTimeout(() => loadComposerLinkPreview(trimmed), 350)
})

watch(unreadTotal, updateAppBadge, { immediate: true })

watch(autoMarkRead, value => {
  localStorage.setItem('wa-ui-auto-mark-read', String(value))
  if (value) autoMarkChatRead()
})

watch(showArchived, value => {
  localStorage.setItem('wa-ui-show-archived', String(value))
  if (selectedChat.value && Boolean(currentChat.value?.isArchived) !== value) {
    selectedChat.value = ''
    messages.value = []
  }
})

watch(showSearchPopup, value => {
  localStorage.setItem('wa-ui-search-open', String(value))
})

watch(archivedCount, count => {
  if (!count && showArchived.value) showArchived.value = false
})

onMounted(() => {
  restoreSession()
  window.addEventListener('paste', onPasteFile)
  window.addEventListener('keydown', onKeydown)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onUnmounted(() => {
  requestPool.cancel()
  window.removeEventListener('paste', onPasteFile)
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  clearTimeout(dragHideTimer)
  clearTimeout(linkPreviewTimer)
  disconnectSocket()
})
</script>

<template>
  <main v-if="authenticated" class="app-shell">
    <aside class="sidebar">
      <header class="topbar">
        <div v-if="bots.length && bots.length < 3" class="client-tabs" role="tablist" aria-label="לקוח">
          <button
            v-for="bot in bots"
            :key="bot.id"
            type="button"
            role="tab"
            :class="{ active: selectedBot === bot.id }"
            :aria-selected="selectedBot === bot.id"
            @click="selectedBot = bot.id"
          >
            <span>{{ bot.label }}</span>
            <b
              v-if="bot.unreadSessionCount"
              :class="{ muted: bot.unreadMutedSessionCount >= bot.unreadSessionCount }"
            >({{ bot.unreadSessionCount }})</b>
          </button>
        </div>
        <select v-else v-model="selectedBot" class="client-select" aria-label="לקוח">
          <option v-for="bot in bots" :key="bot.id" :value="bot.id">{{ bot.label }} ({{ bot.unreadSessionCount || 0 }})</option>
        </select>
        <span :class="['ws-pill', { online: wsState === 'מחובר' }]">{{ wsState }}</span>
        <button class="icon-button" type="button" title="יציאה" @click="logout">יציאה</button>
      </header>

      <section v-if="currentBot?.qr" class="qr-panel">
        <img :src="qrImages[currentBot.id]" alt="קוד התחברות" />
        <strong>סריקה</strong>
      </section>

      <div ref="chatMenuRef" class="chat-menu">
        <div class="menu-header">
          <div class="menu-search-box">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5Zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14Z" fill="currentColor"/></svg>
            <input v-model="search" type="search" placeholder="חיפוש" class="menu-search" />
          </div>
          <button
            class="icon-action menu-mark-read"
            type="button"
            title="סמן הכל כנקרא"
            aria-label="סמן הכל כנקרא"
            @click="markAllRead"
          >
            <svg class="tick-icon double" viewBox="0 0 18 11" aria-hidden="true">
              <path class="tick-back" d="M1.2 5.7 4.6 9 11.7 1.4" />
              <path class="tick-front" d="M6.1 5.7 9.5 9 16.6 1.4" />
            </svg>
          </button>
          <button
            class="icon-action menu-toggle-btn"
            type="button"
            :class="{ active: showMenu }"
            :title="showMenu ? 'סגור תפריט' : 'תפריט'"
            :aria-expanded="showMenu"
            @click="showMenu = !showMenu"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5 5.5 9l1.4-1.4L12 12.7l5.1-5.1L18.5 9 12 15.5Z" fill="currentColor"/></svg>
          </button>
        </div>
        <div v-if="showMenu" class="menu-items">
          <form class="menu-new-chat" @submit.prevent="openNewChat">
            <input v-model="newJid" placeholder="מספר טלפון" class="menu-new-jid" type="tel" dir="ltr" />
            <button type="submit" class="menu-new-btn" title="פתח שיחה חדשה" aria-label="פתח שיחה חדשה">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z" fill="currentColor"/></svg>
            </button>
          </form>
          <label class="menu-read-toggle" title="סמן שיחה כנקראה כשפותחים אותה">
            <input v-model="autoMarkRead" type="checkbox" />
            <span class="switch" aria-hidden="true"></span>
            <span>נקרא בפתיחה</span>
          </label>
        </div>
      </div>

      <div v-if="archivedCount" class="chat-filter-tabs" role="tablist" aria-label="סינון שיחות">
        <button :class="{ active: !showArchived }" type="button" role="tab" :aria-selected="!showArchived" @click="showArchived = false">
          שיחות
          <b v-if="inboxUnreadCount">{{ inboxUnreadCount }}</b>
        </button>
        <button :class="{ active: showArchived }" type="button" role="tab" :aria-selected="showArchived" @click="showArchived = true">
          ארכיון
          <b v-if="archivedUnreadCount">{{ archivedUnreadCount }}</b>
        </button>
        <button v-if="showArchived" class="archive-clear-btn" type="button" title="נקה את כל תוכן השיחות בארכיון" @click="clearAllArchived">נקה הכל
        </button>
      </div>

      <ChatList
        :chats="filteredChats"
        :selected-chat="selectedChat"
        :loading-chats="loadingChats"
        :chat-drop-jid="chatDropJid"
        :selected-bot="selectedBot"
        @select-chat="selectChat"
        @mark-read="markChatRead"
        @toggle-archive="toggleArchiveChat"
        @toggle-mute="toggleMuteChat"
        @clear-chat="clearChatContent"
        @chat-drag-over="onChatDragOver"
        @chat-drag-leave="onChatDragLeave"
        @chat-drop="onChatDrop"
      />
    </aside>

    <section
      :class="['conversation', { dragging: draggingFile }]"
      @dragover.prevent="showDragOverlay"
      @dragenter.prevent="showDragOverlay"
      @dragleave.self="hideDragOverlay"
      @drop.prevent="onDropFile"
    >
      <header class="conversation-head">
        <img :key="selectedChat + AVATAR_VERSION" :src="selectedChat && getAvatarCache(selectedChat) !== false ? `/api/avatar?v=${AVATAR_VERSION}&bot=${encodeURIComponent(selectedBot)}&jid=${encodeURIComponent(selectedChat)}` : ''" alt="" class="large-avatar image" draggable="false" loading="lazy" title="הצג תמונת פרופיל בגודל מלא" @click="openChatAvatar" @error="avatarLoaded = false; setAvatarCache(selectedChat, false); $event.target.style.display='none'" @load="avatarLoaded = true; setAvatarCache(selectedChat, true)" />
        <span :class="['large-avatar', { 'avatar-loaded': avatarLoaded }]" title="הצגה תמונת פרופיל בגודל מלא" @click="openChatAvatar">{{ currentChat ? initials(currentChat) : (selectedChat || '?').slice(0, 2) }}</span>
        <div class="conversation-head-copy" title="פרטי שיחה" @click="showChatInfo = true">
          <h1>{{ chatTitle }}</h1>
          <p>
            {{ chatSubtitle }}
            <span v-if="currentChat?.lastSeen" class="last-seen" :title="formatDateFull(currentChat.lastSeen)">
              &#183; לאחרונה:  {{ formatLastSeen(currentChat.lastSeen) }}
            </span>
          </p>
        </div>
        <button class="icon-action search-toggle" type="button" :class="{ active: showSearchPopup }" title="חיפוש בהודעות" aria-label="חיפוש בהודעות" @click="showSearchPopup = !showSearchPopup">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5Zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14Z" fill="currentColor"/></svg>
        </button>
      </header>

      <ChatThread
        :messages="loadingMessages ? [] : threadMessages"
        :selected-chat="selectedChat"
        :current-chat="currentChat"
        :loading-messages="loadingMessages"
        :loading-older="loadingOlder"
        :action-message-id="actionMessageId"
        :reaction-message-id="reactionMessageId"
        :selected-bot="selectedBot"
        :dragging-file="draggingFile"
        ref="threadRef"
        :emojis="emojis"
        @toggle-message-menu="toggleMessageMenu"
        @set-message-menu="setMessageMenu"
        @set-reaction-menu="setReactionMenu"
        @edit-scheduled="onEditScheduled"
        @reply-message="replyMessage"
        @reply-private="replyPrivate"
        @forward-message="openForwardPopup"
        @delete-message="deleteMessage"
        @load-older="loadOlderMessages"
        @mention-click="(jid) => onMentionClick(jid)"
        @thread-click="onThreadClick"
        @reply-from-thread-dbclick="replyFromThreadDoubleClick"
        @drag-over="showDragOverlay"
        @drag-drop="onDropFile"
        @open-upload-modal="openUploadModal"
        @react="reactToMessage"
        @scroll-to-message="scrollToMessage"
        @typing-expired="clearExpiredTyping"
        @message-update="updateMessage"
        @select-chat="selectChat"
        @button-reply="sendButtonReply"
        @edit-message="startEdit"
        @hover-message="hoveredMessageId = $event"
        @error="error = $event"
      />

      <footer class="composer">
        <p v-if="error" class="error">{{ error }}</p>
        <div v-if="loadingLinkPreview" class="composer-preview-status">
          <span class="spinner" aria-hidden="true"></span>
          Preparing link preview...
        </div>
        <a
          v-else-if="composerLinkPreview && linkPreviewHref({ linkPreview: composerLinkPreview })"
          class="link-preview composer-link-preview"
          :href="linkPreviewHref({ linkPreview: composerLinkPreview })"
          target="_blank"
          rel="noreferrer"
        >
          <img
            v-if="composerLinkPreview.thumbnail"
            :src="composerLinkPreview.thumbnail"
            :width="composerLinkPreview.thumbnailWidth || undefined"
            :height="composerLinkPreview.thumbnailHeight || undefined"
            :style="linkPreviewImageStyle(composerLinkPreview)"
            alt=""
            loading="lazy"
            decoding="async"
          />
          <span class="link-preview-copy">
            <strong dir="auto">{{ composerLinkPreview.title }}</strong>
            <span v-if="composerLinkPreview.description" dir="auto">{{ composerLinkPreview.description }}</span>
            <small dir="ltr">{{ linkPreviewHost({ linkPreview: composerLinkPreview }) }}</small>
          </span>
        </a>
        <div v-if="uploadingFile" class="uploading-strip" dir="auto">
          <img v-if="uploadingPreviewUrl" class="uploading-thumb" :src="uploadingPreviewUrl" alt="" />
          <span v-else class="uploading-icon" aria-hidden="true">📎</span>
          <div class="uploading-copy">
            <strong>{{ uploadingFile.name }}</strong>
            <small><span class="spinner" aria-hidden="true"></span> שולח קובץ…<span v-if="uploadingFile.total > 1"> ({{ uploadingFile.index }}/{{ uploadingFile.total }})</span></small>
          </div>
        </div>
        <div v-if="replyTo" class="reply-strip">
          <div>
            <strong>משיב ל{{ messageSenderName(replyTo) }}</strong>
            <span dir="auto" v-html="messagePreview(replyTo)"></span>
          </div>
          <button type="button" title="בטל תגובה" @click="cancelReply">×</button>
        </div>
        <p v-if="isReadOnly" class="read-only-hint">הקבוצה לקריאה בלבד — רק מנהלים יכולים לשלוח הודעות</p>
        <form class="text-form" @submit.prevent="sendText">
          <div class="composer-actions">
            <div ref="attachMenuRef" class="attach-wrap">
              <button class="icon-action" type="button" :disabled="!selectedChat || isReadOnly" :class="{ active: showAttachMenu }" title="צרף" aria-label="צרף" @click.stop="toggleAttachMenu">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 6v11.5c0 2.485-2.015 4.5-4.5 4.5s-4.5-2.015-4.5-4.5V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H9v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S6 2.79 6 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5Z" fill="currentColor"/></svg>
              </button>
              <div v-if="showAttachMenu" class="attach-menu">
                <button type="button" @click="attachFile">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 6v11.5c0 2.485-2.015 4.5-4.5 4.5s-4.5-2.015-4.5-4.5V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H9v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S6 2.79 6 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5Z" fill="currentColor"/></svg>
                  צרף קובץ
                </button>
                <button type="button" @click="attachContact">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4Zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4Z" fill="currentColor"/></svg>
                  שלח איש קשר
                </button>
              </div>
            </div>
            <button class="icon-action emoji-action" type="button" :disabled="!selectedChat || isReadOnly" :class="{ active: emojiPanelOpen }" title="אימוג׳י" aria-label="אימוג׳י" @click.stop="toggleEmojiPanel">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2ZM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8Zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5Zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11Zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5Z" fill="currentColor"/></svg>
            </button>
          </div>
          <input ref="fileInputRef" class="hidden-file-input" type="file" multiple @change="onFile" />
          <textarea
            ref="textAreaRef"
            v-model="text"
            rows="1"
            :placeholder="isReadOnly ? 'קבוצה לקריאה בלבד' : 'הודעה'"
            :disabled="isReadOnly"
            @input="updateMentionQuery"
            @click="updateMentionQuery"
            @keyup.space="replaceTextEmojis"
            @keydown="onComposerKeydown"
          ></textarea>
          <div v-if="mentionSuggestions.length" class="mention-suggestions">
            <button
              v-for="(participant, index) in mentionSuggestions"
              :key="participant.jid"
              type="button"
              :class="{ active: index === mentionIndex }"
              @mousedown.prevent="insertMention(participant)"
            >
              <strong>{{ participant.name }}</strong>
            </button>
          </div>
          <div class="send-group">
            <button class="send-button" type="submit" :disabled="!selectedChat || busy || isReadOnly">שלח</button>
            <button
              ref="scheduleTriggerRef"
              class="schedule-trigger"
              type="button"
              :class="{ active: showSchedule }"
              :disabled="!selectedChat || isReadOnly"
              title="שליחה מאוחרת"
              aria-label="שליחה מאוחרת"
              @click.stop="toggleSchedule"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5 5.5 9l1.4-1.4L12 12.7l5.1-5.1L18.5 9 12 15.5Z" fill="currentColor"/></svg>
            </button>
          </div>
        </form>
      </footer>
    </section>
  </main>

  <Toaster />

  <Teleport to="body">
    <div v-if="showSchedule" ref="schedulePanelRef" class="schedule-panel" @mousedown.stop @click.stop>
      <strong class="schedule-title">{{ editingScheduledId ? 'עריכת הודעה מתוזמנת' : 'שליחה מאוחרת' }}</strong>
      <div v-if="editingScheduledId" class="schedule-edit-row">
        <input v-model="scheduledEditText" class="schedule-edit-input" type="text" placeholder="הודעה" dir="auto" @keydown.enter.prevent="scheduleMessage" />
        <button type="button" class="schedule-cancel" title="בטל עריכה" @click="cancelScheduledEdit">×</button>
      </div>
      <input v-model="scheduleAt" class="schedule-input" type="datetime-local" :min="toLocalInputValue(new Date())" />
      <button type="button" class="light-button schedule-send" :disabled="scheduling || (editingScheduledId && !scheduledEditText.trim())" @click="scheduleMessage">
        {{ scheduling ? 'שומר…' : editingScheduledId ? 'עדכן' : 'שלח מאוחר יותר' }}
      </button>
      <div v-if="scheduledList.length" class="schedule-list">
        <div
          v-for="item in scheduledList"
          :key="item.id"
          :class="['schedule-item', { editing: editingScheduledId === item.id }]"
        >
          <div class="schedule-item-copy">
            <span dir="auto">{{ item.text }}</span>
            <small>{{ formatDateFull(item.sendAt) }}</small>
          </div>
          <button type="button" class="schedule-edit" title="ערוך" @click="startScheduledEdit(item)">✏️</button>
          <button type="button" class="schedule-cancel" title="בטל" @click="cancelScheduled(item)">×</button>
        </div>
      </div>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="emojiPanelOpen" class="emoji-panel" @mousedown.stop @click.stop>
      <input v-model="emojiSearch" class="emoji-search" type="search" placeholder="חיפוש אימוג׳י…" />
      <template v-if="emojiSearch.trim()">
        <button v-for="entry in emojiResults" :key="entry.emoji" type="button" :title="entry.name" @click="insertEmoji(entry.emoji)">{{ entry.emoji }}</button>
        <small v-if="!emojiResults.length" class="emoji-empty">אין תוצאות</small>
      </template>
      <template v-else>
        <button v-for="emoji in emojis" :key="emoji" type="button" @click="insertEmoji(emoji)">{{ emoji }}</button>
      </template>
    </div>
  </Teleport>

  <Teleport to="body">
    <SearchPopup v-if="showSearchPopup" :selected-bot="selectedBot" :current-chat="selectedChat" @close="showSearchPopup = false" />
    <ChatInfoPopup v-if="showChatInfo && currentChat" :selected-bot="selectedBot" :chat="currentChat" :participants="groupParticipants" :contacts="contacts" @close="showChatInfo = false" @refresh-participants="loadGroupParticipants(selectedBot, selectedChat)" @leave-group="leaveGroup" @chat-changed="loadChats" />
  </Teleport>

  <EditPopup
    :message="editingMessage"
    :busy="editBusy"
    :error="editError"
    @close="closeEdit"
    @save="saveEdit"
  />

  <UploadModal
    ref="uploadModalRef"
    :open="showUploadModal"
    :busy="busy"
    :chat-selected="Boolean(selectedChat)"
    @close="closeUploadModal"
    @send="onFilesSend"
  />

  <ForwardPopup
    :open="showForwardPopup"
    :chats="orderedChats"
    :exclude-jid="selectedChat"
    @close="closeForwardPopup"
    @select="selectForwardTarget"
  />

  <ContactPickerModal
    :open="showContactPicker"
    :contacts="contacts"
    :busy="busy"
    @close="closeContactPicker"
    @send="sendContact"
  />

  <main v-if="!authenticated" class="login-screen">
    <form class="login-card" @submit.prevent="login">
      <h1>WhatsApp</h1>
      <input v-model="password" type="password" placeholder="סיסמה" autofocus />
      <button type="submit">כניסה</button>
      <p v-if="loginError">{{ loginError }}</p>
    </form>
  </main>
</template>
