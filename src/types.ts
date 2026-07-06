// Shared types for the WhatsApp UI server
// Imported from Baileys for type-safe references
import type { proto } from '@whiskeysockets/baileys'
import type { WAMessage, WAMessageKey } from '@whiskeysockets/baileys/lib/Types/Message.js'
import type { Contact } from '@whiskeysockets/baileys/lib/Types/Contact.js'

// -------- Core data types --------

export type QuotedMessage = {
  id: string
  sender: string
  text: string
  mediaKind?: string
}

export type ReactionData = {
  userJid: string
  sender: string
  text: string
  timestamp: number
}

export type CallData = {
  id: string
  status: string
  isVideo: boolean
  durationSecs?: number
  outcome?: string | number
}

export type MediaData = {
  kind: string
  mimetype: string
  caption: string
  fileName?: string
  thumbnail?: string
  width?: number
  height?: number
  url: string
}

export type ContactData = {
  displayName: string
  phone?: string
  vcard?: string
  contacts?: { displayName: string; phone?: string; vcard?: string }[]
}

export type LinkPreviewData = {
  url: string
  matchedText: string
  title: string
  description?: string
  thumbnail?: string
  thumbnailWidth?: number
  thumbnailHeight?: number
}

export type InteractiveButton = {
  text: string
  /** Button action type: 'quick_reply' | 'url' | 'call' | 'cta_url' | 'copy_code' | 'flow' | ... */
  type?: string
  /** Original native-flow button name (e.g. 'cta_url', 'quick_reply', 'copy_code') */
  name?: string
  url?: string
  phone?: string
  code?: string
  id?: string
}

export type InteractiveRow = {
  title: string
  description?: string
  rowId: string
}

export type InteractiveSection = {
  title?: string
  rows: InteractiveRow[]
}

export type InteractiveData = {
  type: 'template' | 'buttons' | 'list' | 'interactive'
  title?: string
  body?: string
  footer?: string
  header?: string
  buttonText?: string
  buttons?: InteractiveButton[]
  sections?: InteractiveSection[]
}

export type GroupMention = {
  jid: string
  name: string
  phoneNumber: string
}

export type UiMessage = {
  id: string
  jid: string
  key: WAMessageKey
  raw?: WAMessage
  status?: number | string
  receipt?: proto.IUserReceipt
  userReceipt?: proto.IUserReceipt[]
  edited?: boolean
  deleted?: boolean
  deletedAt?: number
  deletedBy?: string
  quoted?: QuotedMessage
  reactions?: ReactionData[]
  call?: CallData
  contact?: ContactData
  media?: MediaData
  linkPreview?: LinkPreviewData
  interactiveData?: InteractiveData
  viewOnce?: boolean
  viewOnceType?: string
  forwarded?: boolean
  downloadable?: boolean
  fromMe: boolean
  sender: string
  senderNumber?: string
  text: string
  type: string
  timestamp: number
}

export type UiChat = {
  jid: string
  displayJid: string
  phoneNumber: string
  name: string
  lastMessage: string
  timestamp: number
  unread: number
  isGroup: boolean
  isMuted?: boolean
  isArchived?: boolean
  participantCount?: number
  lastMessageFromMe?: boolean
  lastMessageStatus?: number | string
  lastMessageReceipt?: proto.IUserReceipt
  lastMessageUserReceipt?: proto.IUserReceipt[]
  lastSeen?: number
  typing?: string | null
  typingTimestamp?: number
}

// -------- Patch types (replace Record<string, any>) --------

/**
 * A typed message patch — only the fields that can change after a message is created.
 * Using Partial<UiMessage> gives full type safety vs Record<string, any>.
 */
export type MessagePatch = Partial<{
  id: string
  jid: string
  key: WAMessageKey
  raw?: WAMessage
  status: number | string
  receipt: proto.IUserReceipt
  userReceipt: proto.IUserReceipt[]
  edited: boolean
  deleted: boolean
  deletedAt: number
  deletedBy: string
  quoted: QuotedMessage
  reactions: ReactionData[]
  reaction: ReactionData  // single reaction to add/remove
  call: CallData
  contact: ContactData
  media: MediaData
  linkPreview: LinkPreviewData
  interactiveData: InteractiveData
  viewOnce: boolean
  viewOnceType: string
  forwarded: boolean
  downloadable: boolean
  fromMe: boolean
  sender: string
  senderNumber: string
  text: string
  type: string
  timestamp: number
}>

// -------- Bot status --------

export type BotStatus = {
  id: string
  authKey: string
  label: string
  connection: string
  qr: string
  chatCount: number
  unreadSessionCount: number
}

// -------- WebSocket event payloads --------

export type WsEventConnection = {
  type: 'connection'
  bot: string
  status: BotStatus
}

export type WsEventChat = {
  type: 'chat'
  bot: string
  chat: UiChat
}

export type WsEventChatMerge = {
  type: 'chat-merge'
  bot: string
  fromJid: string
  toJid: string
  chat: UiChat
}

export type WsEventMessage = {
  type: 'message'
  bot: string
  message: UiMessage
  chat: UiChat
}

export type WsEventMessageUpdate = {
  type: 'message-update'
  bot: string
  jid: string
  id: string
  patch: MessagePatch
}

export type WsEventPayload =
  | WsEventConnection
  | WsEventChat
  | WsEventChatMerge
  | WsEventMessage
  | WsEventMessageUpdate
  | { type: 'init'; bots: BotStatus[] }

// -------- Presence / typing --------

export type PresenceData = {
  lastKnownPresence?: string
  lastSeen?: number
}

// -------- Contact cache --------

export type ContactCacheDeps = {
  redis: any
  label: string
  contactCacheKey: string
  lidCacheKey: string
  chatCacheKey: string
  chatIndexKey: string
  groupMetadataCacheKey: (jid: string) => string
  groupMetadataCacheMs: number
  getSock: () => any
  getOwnId: () => string
  contacts: Map<string, Partial<Contact>>
  lidToPhone: Map<string, string>
  chats: Map<string, UiChat>
  onChatEvent: (chat: UiChat) => void
  onChatMerge: (fromJid: string, toJid: string, chat: UiChat) => void
  loadAvatar: (jid: string) => Promise<string | void>
  persistChat: (chat: UiChat) => void
  trimChatCache: () => void
  removeChatStore: (jid: string) => Promise<void>
  removeMessageStore: (jid: string) => Promise<void>
  removeNonChat: (jid: string) => void
  restoreMessages: () => Promise<void>
}

// -------- Chat store --------

export type ChatStoreDeps = {
  redis: any
  label: string
  chatCacheKey: string
  chatIndexKey: string
  messagePayloadKey: (jid: string, id: string) => string
  chatSettingsSyncKey: string
  CHAT_LIMIT: number
  CHAT_SETTINGS_RESYNC_INTERVAL_MS: number
  canonicalJid: (jid: string) => string
  isOwnReceipt: (receipt: proto.IUserReceipt) => boolean
  chats: Map<string, UiChat>
  listChats: () => UiChat[]
  sock: { current: any }
  onChatEvent: (chat: UiChat) => void
}

// -------- Message store --------

export type MessageStoreDeps = {
  redis: any
  label: string
  messageIndexKey: (jid: string) => string
  messagePayloadKey: (jid: string, id: string) => string
  mediaCacheKey: (jid: string, id: string) => string
  MEDIA_CACHE_TTL_SECONDS: number
  STORED_MESSAGE_LIMIT: number
  MEMORY_MESSAGE_LIMIT: number
  HISTORY_SYNC_WAIT_MS: number
  canonicalJid: (jid: string) => string
  messages: Map<string, UiMessage[]>
  chats: Map<string, UiChat>
  listChats: () => UiChat[]
  getSock: () => any
  publicMessage: (message: UiMessage) => UiMessage
  onMessageEvent: (jid: string, id: string, patch: MessagePatch) => void
}
