<script setup>
import QRCode from 'qrcode'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useBlob } from './composables/useBlob.js'
import {
  formatTime, formatDateFull, formatDateCaption, formatLastSeen, initials, avatarUrl, setAvatarCache, getAvatarCache, AVATAR_VERSION
} from './helpers.js'
import {
  hasLinkCandidate, linkPreviewHref, linkPreviewHost, linkPreviewImageStyle, messagePreview
} from './message-renderer.js'
import { messageStatusRank, mergeMessagePatch, reactionUserKey } from '../../src/message-utils.ts'
import ChatList from './ChatList.vue'
import ChatThread from './ChatThread.vue'
import SearchPopup from './SearchPopup.vue'
import ChatInfoPopup from './ChatInfoPopup.vue'

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
const showArchived = ref(localStorage.getItem('wa-ui-show-archived') === 'true')
const autoMarkRead = ref(localStorage.getItem('wa-ui-auto-mark-read') === 'true')
const contacts = ref([])
const avatarLoaded = ref(false)
const avatarCache = {}
const newJid = ref('')
const text = ref('')
const textAreaRef = ref(null)
const caption = ref('')
const selectedFile = ref(null)
const selectedFileForwarded = ref(false)
const fileInputRef = ref(null)
const captionInputRef = ref(null)
const draggingFile = ref(false)
const chatDropJid = ref('')
const showUploadModal = ref(false)
const showForwardPopup = ref(false)
const showContactPicker = ref(false)
const showSearchPopup = ref(localStorage.getItem('wa-ui-search-open') === 'true')
const showChatInfo = ref(false)
const selectedContactForSend = ref(null)
const contactSearch = ref('')
const showComposerMenu = ref(false)
const forwardMessageId = ref('')
const forwardSourceJid = ref('')
const forwardTargetJid = ref('')
const forwardSearch = ref('')
const actionMessageId = ref('')
const reactionMessageId = ref('')
const replyTo = ref(null)
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
const wsState = ref('מנותק')
const qrImages = ref({})
const threadRef = ref(null)
let reconnectTimer
let botRefreshTimer
let dragHideTimer
let linkPreviewTimer
let ws
let chatLoadRequest = 0
let messageLoadRequest = 0
let linkPreviewRequest = 0
const markingRead = new Set()

const { url: selectedFilePreviewUrl, setBlob: setFilePreviewBlob, clearBlob: clearFilePreviewBlob } = useBlob()

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
const currentChat = computed(() => chats.value.find(chat => chat.jid === selectedChat.value))
const chatTitle = computed(() => currentChat.value?.name || selectedChat.value || 'בחרו שיחה')
const chatSubtitle = computed(() => ""/* currentChat.value ? chatAddress(currentChat.value) : selectedChat.value*/)
const selectedFileName = computed(() => selectedFile.value?.name || '')
const selectedFileIsImage = computed(() => Boolean(selectedFile.value?.type?.startsWith('image/') && selectedFilePreviewUrl.value))
const emojis = computed(() => [...new Set([...usedEmojis.value, ...defaultEmojis])].slice(0, 48))
const unreadTotal = computed(() => chats.value.filter(chat => Number(chat.unread || 0) > 0).length)
const archivedCount = computed(() => chats.value.filter(chat => chat.isArchived).length)
const archivedUnreadCount = computed(() => chats.value.filter(chat => chat.isArchived && Number(chat.unread || 0) > 0).length)
const inboxUnreadCount = computed(() => chats.value.filter(chat => !chat.isArchived && Number(chat.unread || 0) > 0).length)
const orderedChats = computed(() => [...chats.value].sort((a, b) => {
  const aActive = Number(Boolean(a.timestamp || a.lastMessage))
  const bActive = Number(Boolean(b.timestamp || b.lastMessage))
  if (aActive !== bActive) return bActive - aActive
  return (b.timestamp || 0) - (a.timestamp || 0)
}))
const filteredChats = computed(() => {
  const term = searchable(search.value).trim()
  const identityTerm = searchableIdentity(search.value).trim()
  let list = orderedChats.value.filter(chat => Boolean(chat.isArchived) === showArchived.value)
  if (!term) return list
  const phoneTerms = phoneSearchTerms(identityTerm || term)
  list = list.filter(chat =>
    searchable(chat.name).includes(term) ||
    identityMatches(chat.jid, identityTerm) ||
    identityMatches(chat.displayJid, identityTerm) ||
    identityMatches(chat.phoneNumber, identityTerm) ||
    searchable(chat.lastMessage).includes(term) ||
    phoneTerms.some(phoneTerm => chatPhoneValues(chat).some(value => value.includes(phoneTerm)))
  )
  // Also search through contacts that don't have a chat yet
  const seenIdentities = new Set(chats.value.flatMap(item => identityKeys(item)))
  const matchedContacts = []
  for (const contact of contacts.value) {
    const keys = identityKeys(contact)
    if (keys.some(key => seenIdentities.has(key))) continue
    if (
      !searchable(contact?.name).includes(term) &&
      !identityMatches(contact?.jid, identityTerm) &&
      !identityMatches(contact?.phoneNumber, identityTerm) &&
      !phoneTerms.some(phoneTerm => [contact?.phoneNumber, contact?.jid].filter(Boolean).some(value => safeText(value).includes(phoneTerm)))
    ) continue
    keys.forEach(key => seenIdentities.add(key))
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

/** Strip WhatsApp identity suffix and return clean digits */
function cleanPhone(value) {
  const raw = String(value || '').replace(/@.*$/, '')
  return raw.replace(/[^\d]/g, '')
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
  return fetch(path, {
    ...options,
    headers: options.headers || {}
  }).then(async response => {
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(data.error || 'שגיאה')
      error.status = response.status
      throw error
    }
    return data
  })
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

function scheduleBotRefresh() {
  clearTimeout(botRefreshTimer)
  botRefreshTimer = setTimeout(refreshBots, 300)
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
    await setBots(data.bots || [])
    connectWs()
    await loadChats()
    await loadContacts()
  } catch (err) {
    loginError.value = err.message
  }
}

async function restoreSession() {
  try {
    const data = await api('/api/session')
    authenticated.value = true
    await setBots(data.bots || [])
    connectWs()
    await loadChats()
    await loadContacts()
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
  ws?.close()
}

function connectWs() {
  ws?.close()
  clearTimeout(reconnectTimer)
  wsState.value = 'מתחבר'
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${protocol}//${location.host}/ws`)
  ws.onopen = () => {
    wsState.value = 'מחובר'
  }
  ws.onmessage = async event => {
    const data = JSON.parse(event.data)
    if (data.type === 'init') {
      // Update bots list without switching the selected bot
      const nextBots = data.bots || []
      bots.value = nextBots
      if (!nextBots.some(bot => bot.id === selectedBot.value)) {
        selectedBot.value = nextBots[0]?.id || ''
      }
      localStorage.setItem('wa-ui-selected-bot', selectedBot.value)
      await Promise.all(nextBots.map(refreshQr))
      if (!chats.value.length) await loadChats()
      await loadContacts()
    }
    if (data.type === 'connection') {
      const next = bots.value.map(bot => bot.id === data.bot ? { ...bot, ...data.status } : bot)
      await setBots(next)
    }
    if (data.type === 'account-purged' && data.bot === selectedBot.value) {
      chats.value = []
      messages.value = []
      selectedChat.value = ''
    }
    if (data.type === 'chat') {
      if (data.bot === selectedBot.value) {
        upsertChat(data.chat)
      }
    }
    if (data.type === 'chat') scheduleBotRefresh()
    if (data.type === 'chat-merge' && data.bot === selectedBot.value) {
      chats.value = chats.value.filter(chat => chat.jid !== data.fromJid)
      upsertChat(data.chat)
      if (selectedChat.value === data.fromJid) selectedChat.value = data.toJid
    }
    if (data.type === 'chat-merge') scheduleBotRefresh()
    if (data.type === 'message-update' && data.bot === selectedBot.value && data.jid === selectedChat.value) {
      messages.value = messages.value.map(message => message.id === data.id ? mergeMessagePatch(message, data.patch) : message)
    }
    if (data.type === 'message' && data.bot === selectedBot.value) {
      upsertChat(data.chat)
      if (data.message.jid === selectedChat.value) {
        upsertMessage(data.message)
        if (!data.message.fromMe) autoMarkChatRead(data.message.jid)
        scrollToBottom()
      }
    }
    if (data.type === 'message') scheduleBotRefresh()
    if (data.type === 'refresh' && data.bot === selectedBot.value) {
      await loadChats()
      await loadContacts()
    }
    if (data.type === 'refresh') scheduleBotRefresh()
  }
  ws.onclose = () => {
    wsState.value = 'מנותק'
    if (authenticated.value) reconnectTimer = setTimeout(connectWs, 2000)
  }
  ws.onerror = () => {
    wsState.value = 'שגיאה'
  }
}

function upsertChat(chat) {
  const existing = chats.value.find(item => item.jid === chat.jid)
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
  if (!chat.isGroup) {
    const contact = contacts.value.find(c => c.jid === chat.jid || c.phoneNumber === chat.jid)
    if (contact && contact.name !== chat.name) {
      chat.name = contact.name
    }
  }
  const rest = chats.value.filter(item => item.jid !== chat.jid)
  chats.value = [chat, ...rest]
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
  if (!bot || !authenticated.value) return
  const requestId = ++chatLoadRequest
  try {
    error.value = ''
    loadingChats.value = true
    const data = await api(`/api/chats?bot=${encodeURIComponent(bot)}`)
    if (selectedBot.value !== bot || requestId !== chatLoadRequest) return
    chats.value = data.chats || []
    if (!selectedChat.value && filteredChats.value[0]) await selectChat(filteredChats.value[0].jid)
  } catch (err) {
    if (selectedBot.value !== bot || requestId !== chatLoadRequest) return
    if (err.status === 404 && !retried) {
      const data = await api('/api/session')
      await setBots(data.bots || [])
      await loadChats(true)
      return
    }
    chats.value = []
    selectedChat.value = ''
    messages.value = []
    error.value = err.message
  } finally {
    if (requestId === chatLoadRequest) loadingChats.value = false
  }
}

async function loadContacts() {
  const bot = selectedBot.value
  if (!bot || !authenticated.value) return
  try {
    const data = await api(`/api/contacts?bot=${encodeURIComponent(bot)}`)
    contacts.value = data.contacts || []
  } catch (err) {
    // Contacts are optional; don't fail on error
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
  if (document.visibilityState === 'visible') autoMarkChatRead()
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

async function sendText() {
  if (!selectedChat.value || !text.value.trim() || showUploadModal.value) return
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
      scrollToBottom()
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

async function sendContact() {
  if (!selectedChat.value || !selectedContactForSend.value) return
  const contact = selectedContactForSend.value
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
      scrollToBottom()
    }
  } catch (err) {
    error.value = err.message
  }
}

function openContactPicker() {
  showContactPicker.value = true
  contactSearch.value = ''
  selectedContactForSend.value = null
  actionMessageId.value = ''
}

function closeContactPicker() {
  showContactPicker.value = false
  selectedContactForSend.value = null
}

// Generate vCard for a contact client-side
function makeVcard(contact) {
  const phone = (contact.phoneNumber || '').replace(/[^\d]/g, '')
  if (!phone || !contact.name) return ''
  return `BEGIN:VCARD\nVERSION:3.0\nFN:${contact.name}\nTEL;TYPE=CELL:+${phone}\nEND:VCARD`
}

const filteredContacts = computed(() => {
  const term = searchable(contactSearch.value).trim()
  let list = contacts.value.filter(c => c.phoneNumber && c.name)
  if (!term) return list.slice(0, 100)
  return list.filter(c => {
    const nameMatch = searchable(c.name).includes(term)
    // Search phone by clean digits (strips @s.whatsapp.net suffix)
    const phoneClean = cleanPhone(c.phoneNumber)
    const phoneMatch = phoneClean.includes(term) || term.includes(phoneClean)
    return nameMatch || phoneMatch
  }).slice(0, 100)
})

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
      scrollToBottom()
    }
  } catch (err) {
    error.value = err.message
  }
}

function openForwardPopup(message) {
  forwardMessageId.value = message.id
  forwardSourceJid.value = message.jid || selectedChat.value
  forwardSearch.value = ''
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

const forwardableChats = computed(() => {
  const term = searchable(forwardSearch.value).trim()
  const identityTerm = searchableIdentity(forwardSearch.value).trim()
  const list = orderedChats.value.filter(chat => chat.jid !== selectedChat.value)
  if (!term) return list.slice(0, 50)
  return list.filter(chat =>
    searchable(chat.name).includes(term) ||
    identityMatches(chat.jid, identityTerm) ||
    identityMatches(chat.displayJid, identityTerm) ||
    identityMatches(chat.phoneNumber, identityTerm)
  ).slice(0, 50)
})

function replyMessage(message) {
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

async function deleteMessage(message) {
  if (!selectedChat.value || !message?.id || message.deleted) return
  actionMessageId.value = ''
  reactionMessageId.value = ''
  error.value = ''
  try {
    const data = await api('/api/delete-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: selectedBot.value, jid: selectedChat.value, id: message.id })
    })
    messages.value = messages.value.map(item => item.id === message.id ? mergeMessagePatch(item, data.patch || { deleted: true }) : item)
  } catch (err) {
    error.value = err.message
  }
}

function toggleReactionMenu(message) {
  reactionMessageId.value = reactionMessageId.value === message.id ? '' : message.id
}

async function reactToMessage(message, emoji) {
  if (!selectedChat.value || !message?.id) return
  reactionMessageId.value = ''
  actionMessageId.value = ''
  if (emoji) {
    usedEmojis.value = [emoji, ...usedEmojis.value.filter(item => item !== emoji)].slice(0, 24)
    localStorage.setItem('wa-ui-used-emojis', JSON.stringify(usedEmojis.value))
  }
  error.value = ''
  try {
    const data = await api('/api/react-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: selectedBot.value, jid: selectedChat.value, id: message.id, emoji })
    })
    messages.value = messages.value.map(item => item.id === message.id ? mergeMessagePatch(item, data.patch || {}) : item)
  } catch (err) {
    error.value = err.message
  }
}

function toggleEmojiPanel() {
  emojiPanelOpen.value = !emojiPanelOpen.value
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

async function sendFile() {
  if (busy.value || !selectedChat.value || !selectedFile.value) return
  busy.value = true
  error.value = ''
  try {
    const form = new FormData()
    form.append('bot', selectedBot.value)
    form.append('jid', activeSendJid())
    form.append('caption', caption.value)
    form.append('forwarded', String(selectedFileForwarded.value))
    form.append('file', selectedFile.value)
    const data = await api('/api/send-file', { method: 'POST', body: form })
    if (data.message?.jid === selectedChat.value) {
      upsertMessage(data.message)
      scrollToBottom()
    }
    // Clear the composer text since it was used as the file caption
    text.value = ''
    clearFile()
    showUploadModal.value = false
  } catch (err) {
    error.value = err.message
  } finally {
    busy.value = false
  }
}

function onFile(event) {
  const file = event.target.files?.[0]
  if (file) openUploadModal(file)
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
  const file = event.dataTransfer?.files?.[0]
  if (file) openUploadModal(file)
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
  const file = [...(event.clipboardData?.files || [])][0]
  if (!file) return
  event.preventDefault()
  openUploadModal(file)
}

function openUploadPicker() {
  if (!selectedChat.value) return
  fileInputRef.value?.click()
}

function openUploadModal(file, forwarded = false) {
  if (!selectedChat.value) return
  if (file) {
    clearFilePreviewBlob()
    selectedFile.value = file
    selectedFileForwarded.value = forwarded
    if (file.type?.startsWith('image/')) setFilePreviewBlob(file)
  }
  // Pre-fill caption with the current text from the composer input
  caption.value = text.value
  showUploadModal.value = true
  nextTick(() => captionInputRef.value?.focus())
}

function closeUploadModal() {
  showUploadModal.value = false
}

function onKeydown(event) {
  if (event.key === 'Escape' && showUploadModal.value) closeUploadModal()
  if (event.key === 'Escape') {
    actionMessageId.value = ''
    reactionMessageId.value = ''
    replyTo.value = null
    emojiPanelOpen.value = false
  }
  const target = event.target
  const isEditing = target?.matches?.('input, textarea, select, [contenteditable="true"]')
  if (!isEditing && selectedChat.value && !showUploadModal.value && !event.ctrlKey && !event.metaKey && !event.altKey && event.key?.length === 1) {
    event.preventDefault()
    insertComposerText(event.key)
    if (event.key === ' ') nextTick(replaceTextEmojis)
  }
}

function clearFile() {
  clearFilePreviewBlob()
  selectedFile.value = null
  selectedFileForwarded.value = false
  caption.value = ''
  if (fileInputRef.value) fileInputRef.value.value = ''
}

function scrollToBottom() {
  nextTick(() => {
    if (threadRef.value) threadRef.value.scrollToBottom()
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
  if (!('setAppBadge' in navigator) || !('clearAppBadge' in navigator)) return
  if (count > 0) navigator.setAppBadge(count).catch(() => {})
  else navigator.clearAppBadge().catch(() => {})
  updateFaviconBadge(count)
}

/** Generate a favicon SVG data URL with a red badge overlay showing the unread count.
 *  Uses inline SVG markup so it works in all browsers without canvas/image loading issues.
 */
function updateFaviconBadge(count) {
  const link = document.querySelector('link[rel="icon"]')
  if (!link) return

  if (count > 0) {
    link.setAttribute('href', generateBadgeSvg(count))
  } else {
    link.setAttribute('href', '/favicon.svg')
  }
}

/** Generate an inline SVG data URL that overlays a red badge on the WhatsApp favicon */
function generateBadgeSvg(count) {
  const text = count > 99 ? '99+' : String(count)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="14" fill="#166a5b"/>
    <path fill="#fff" d="M31.5 12C20.2 12 11 20.4 11 30.8c0 3.7 1.2 7.2 3.3 10.2L12 52l11.6-3c2.5 1 5.2 1.6 7.9 1.6C42.8 50.6 52 42.2 52 31.8S42.8 12 31.5 12Z" opacity=".96"/>
    <path fill="#166a5b" d="M42.8 37.4c-.5 1.4-2.6 2.5-3.8 2.6-1 .1-2.3.1-3.8-.5-3.3-1.1-7.2-3.9-10-7.5-2.5-3.1-3.3-5.8-3.4-6.7-.2-1.4.4-3.2 1.8-4.1.5-.3 1.2-.3 1.6-.3h1.1c.4 0 .8.1 1.1.9.4 1 .9 2.4 1 2.6.1.3.2.7 0 1-.2.4-.3.5-.6.8l-.7.8c-.2.2-.5.5-.2 1 .3.6 1.4 2.2 2.9 3.5 2 1.7 3.6 2.3 4.2 2.6.5.2.8.2 1.1-.1.3-.4 1.3-1.4 1.6-1.9.4-.5.7-.4 1.2-.3.5.2 3.1 1.4 3.6 1.7.5.2.9.4 1 .7.2.4.2 1.8-.3 3.2Z"/>
    <circle cx="50" cy="14" r="14" fill="#ff0000"/>
    <text x="50" y="17" fill="#fff" font-size="12" font-weight="bold" text-anchor="middle" font-family="sans-serif">${text}</text>
  </svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

watch(selectedChat, (jid) => { avatarLoaded.value = avatarCache[jid] === true })

watch(selectedBot, async (val, oldVal) => {
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
  try {
    await loadChats()
    await loadContacts()
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
  window.removeEventListener('paste', onPasteFile)
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  clearTimeout(reconnectTimer)
  clearTimeout(botRefreshTimer)
  clearTimeout(dragHideTimer)
  clearTimeout(linkPreviewTimer)
  updateAppBadge(0)
  ws?.close()
})
</script>

<template>
  <main v-if="authenticated" class="app-shell">
    <aside class="sidebar">
      <header class="topbar">
        <select v-model="selectedBot" class="client-select" aria-label="לקוח">
          <option v-for="bot in bots" :key="bot.id" :value="bot.id">{{ bot.label }} ({{ bot.unreadSessionCount || 0 }})</option>
        </select>
        <span :class="['ws-pill', { online: wsState === 'מחובר' }]">{{ wsState }}</span>
        <button class="icon-button" type="button" title="יציאה" @click="logout">יציאה</button>
      </header>

      <section v-if="currentBot?.qr" class="qr-panel">
        <img :src="qrImages[currentBot.id]" alt="קוד התחברות" />
        <strong>סריקה</strong>
      </section>

      <div class="chat-menu">
        <div class="menu-header">
          <input v-model="search" type="search" placeholder="חיפוש" class="menu-search" />
          <button class="menu-toggle-btn" type="button" @click="showMenu = !showMenu" :title="showMenu ? 'סגור תפריט' : 'תפריט'">
            {{ showMenu ? '&#183;' : '&#183;' }}{{ '\u00A0' }}{{ showMenu ? '\u2039' : '\u203A' }}
          </button>
        </div>
        <div v-if="showMenu" class="menu-items">
          <form class="menu-new-chat" @submit.prevent="openNewChat">
            <input v-model="newJid" placeholder="מספר" class="menu-new-jid" />
            <button type="submit" class="menu-new-btn" title="פתח שיחה חדשה">➕</button>
          </form>
          <label class="menu-read-toggle" title="סמן שיחה כנקראה כשפותחים אותה">
            <input v-model="autoMarkRead" type="checkbox" />
            <span>נקרא</span>
          </label>
          <button class="menu-mark-read" type="button" title="סמן הכל כנקרא" @click="markAllRead">הכל נקרא</button>
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
        <img :key="selectedChat + AVATAR_VERSION" :src="selectedChat && getAvatarCache(selectedChat) !== false ? `/api/avatar?v=${AVATAR_VERSION}&bot=${encodeURIComponent(selectedBot)}&jid=${encodeURIComponent(selectedChat)}` : ''" alt="" class="large-avatar image" loading="lazy" @error="avatarLoaded = false; setAvatarCache(selectedChat, false); $event.target.style.display='none'" @load="avatarLoaded = true; setAvatarCache(selectedChat, true)" />
        <span :class="['large-avatar', { 'avatar-loaded': avatarLoaded }]">{{ currentChat ? initials(currentChat) : (selectedChat || '?').slice(0, 2) }}</span>
        <div class="conversation-head-copy" title="פרטי שיחה" @click="showChatInfo = true">
          <h1>{{ chatTitle }}</h1>
          <p>
            {{ chatSubtitle }}
            <span v-if="currentChat?.lastSeen" class="last-seen" :title="formatDateFull(currentChat.lastSeen)">
              &#183; לאחרונה:  {{ formatLastSeen(currentChat.lastSeen) }}
            </span>
          </p>
        </div>
        <button class="icon-button search-toggle" type="button" :class="{ active: showSearchPopup }" title="חיפוש בהודעות" @click="showSearchPopup = !showSearchPopup">🔍</button>
      </header>

      <ChatThread
        :messages="loadingMessages ? [] : messages"
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
        @reply-message="replyMessage"
        @reply-private="replyPrivate"
        @forward-message="openForwardPopup"
        @toggle-reaction-menu="toggleReactionMenu"
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
        <div v-if="replyTo" class="reply-strip">
          <div>
            <strong>משיב ל{{ messageSenderName(replyTo) }}</strong>
            <span dir="auto" v-html="messagePreview(replyTo)"></span>
          </div>
          <button type="button" title="בטל תגובה" @click="cancelReply">×</button>
        </div>
        <form class="text-form" @submit.prevent="sendText">
          <div class="composer-actions">
            <button class="action-button" type="button" :disabled="!selectedChat" title="צרף קובץ" @click="openUploadPicker">📎</button>
            <button class="action-button" type="button" :disabled="!selectedChat" title="שלח איש קשר" @click="openContactPicker">👤</button>
            <button class="action-button emoji-action" type="button" :disabled="!selectedChat" title="אימוג׳י" @click.stop="toggleEmojiPanel">
              ☺
            </button>
          </div>
          <input ref="fileInputRef" class="hidden-file-input" type="file" @change="onFile" />
          <textarea
            ref="textAreaRef"
            v-model="text"
            rows="1"
            placeholder="הודעה"
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
          <button type="submit" :disabled="!selectedChat || busy">{{ busy ? 'Preparing...' : 'שלח' }}</button>
        </form>
      </footer>
    </section>
  </main>

  <Teleport to="body">
    <div v-if="emojiPanelOpen" class="emoji-panel" @mousedown.stop @click.stop>
      <button v-for="emoji in emojis" :key="emoji" type="button" @click="insertEmoji(emoji)">{{ emoji }}</button>
    </div>
  </Teleport>

  <Teleport to="body">
    <SearchPopup v-if="showSearchPopup" :selected-bot="selectedBot" :current-chat="selectedChat" @close="showSearchPopup = false" />
    <ChatInfoPopup v-if="showChatInfo && currentChat" :selected-bot="selectedBot" :chat="currentChat" :participants="groupParticipants" :contacts="contacts" @close="showChatInfo = false" @refresh-participants="loadGroupParticipants(selectedBot, selectedChat)" @leave-group="leaveGroup" @chat-changed="loadChats" />
  </Teleport>

  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="showUploadModal"
        class="modal-mask upload-modal-mask"
        role="dialog"
        aria-modal="true"
        @mousedown.self="closeUploadModal"
      >
        <section class="modal-wrapper upload-window" @mousedown.stop @keydown.enter.exact.prevent="sendFile">
          <header class="modal-header">
            <strong>שליחת קובץ</strong>
            <button type="button" class="modal-close" title="סגור" @click="closeUploadModal">×</button>
          </header>
          <form class="modal-body upload-form" @submit.prevent="sendFile">
            <div
              class="upload-dropzone"
              @dragover.prevent
              @drop.prevent="onDropFile"
            >
              <img v-if="selectedFileIsImage" class="upload-preview-image" :src="selectedFilePreviewUrl" alt="" />
              <strong>{{ selectedFileName || 'גרור קובץ לכאן' }}</strong>
              <small>אפשר גם להדביק מהלוח או לבחור קובץ</small>
              <button type="button" class="light-button" @click="openUploadPicker">בחר קובץ</button>
            </div>
            <input ref="captionInputRef" v-model="caption" class="caption-input" placeholder="כיתוב לקובץ" />
            <div class="upload-actions">
              <button type="button" class="light-button" :disabled="!selectedFile" @click="clearFile">נקה</button>
              <button type="submit" :disabled="busy || !selectedFile || !selectedChat">שלח</button>
            </div>
          </form>
        </section>
      </div>
    </Transition>
  </Teleport>

  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="showForwardPopup"
        class="modal-mask forward-modal-mask"
        role="dialog"
        aria-modal="true"
        @mousedown.self="closeForwardPopup"
      >
        <section class="modal-wrapper forward-window" @mousedown.stop>
          <header class="modal-header">
            <strong>העבר הודעה ל...</strong>
            <button type="button" class="modal-close" title="סגור" @click="closeForwardPopup">×</button>
          </header>
          <div class="modal-body forward-list">
            <input v-model="forwardSearch" class="forward-search" placeholder="חיפוש שיחה" />
            <div class="forward-items">
              <button
                v-for="chat in forwardableChats"
                :key="chat.jid"
                class="forward-item"
                type="button"
                @click="selectForwardTarget(chat.jid)"
              >
                <span class="forward-item-avatar">
                  <span class="avatar">{{ initials(chat) }}</span>
                </span>
                <span class="forward-item-name">{{ chat.name }}</span>
                <small class="forward-item-jid">{{ chat.displayJid || chat.phoneNumber || '' }}</small>
              </button>
              <p v-if="!forwardableChats.length" class="empty-list">אין שיחות להצגה</p>
            </div>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>

  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="showContactPicker"
        class="modal-mask contact-modal-mask"
        role="dialog"
        aria-modal="true"
        @mousedown.self="closeContactPicker"
      >
        <section class="modal-wrapper contact-window" @mousedown.stop @keydown.enter.exact.prevent="sendContact">
          <header class="modal-header">
            <strong>שלח איש קשר</strong>
            <button type="button" class="modal-close" title="סגור" @click="closeContactPicker">×</button>
          </header>
          <div class="modal-body contact-list">
            <input v-model="contactSearch" class="contact-search" placeholder="חיפוש איש קשר" />
            <div class="contact-items">
              <button
                v-for="contact in filteredContacts"
                :key="contact.jid"
                class="contact-item"
                type="button"
                :class="{ selected: selectedContactForSend?.jid === contact.jid }"
                @click="selectedContactForSend = contact"
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
            <button type="button" class="light-button" @click="closeContactPicker">ביטול</button>
            <button type="submit" :disabled="!selectedContactForSend || busy" @click="sendContact">שלח איש קשר</button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>

  <main v-if="!authenticated" class="login-screen">
    <form class="login-card" @submit.prevent="login">
      <h1>WhatsApp</h1>
      <input v-model="password" type="password" placeholder="סיסמה" autofocus />
      <button type="submit">כניסה</button>
      <p v-if="loginError">{{ loginError }}</p>
    </form>
  </main>
</template>
