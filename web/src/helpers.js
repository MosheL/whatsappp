export function formatTime(value) {
  if (!value) return ''
  return new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

export function formatDateFull(value) {
  if (!value) return ''
  return new Intl.DateTimeFormat('he-IL', { dateStyle: 'full', timeStyle: 'short' }).format(new Date(value))
}

export function formatDateCaption(value) {
  if (!value) return ''
  const now = new Date()
  const date = new Date(value)
  const diff = Math.floor((now - date) / (1000 * 60 * 60 * 24))
  if (diff === 0) return 'היום'
  if (diff === 1) return 'אתמול'
  if (diff === 2) return 'שלשום'
  return new Intl.DateTimeFormat('he-IL', { dateStyle: 'full' }).format(date)
}

export function formatLastSeen(value) {
  if (!value) return ''
  const now = new Date()
  const date = new Date(value)
  const diff = Math.floor((now - date) / (1000 * 60 * 60 * 24))
  const time = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' }).format(date)
  if (diff === 0) return '' + time
  if (diff === 1) return 'אתמול ' + time
  if (diff === 2) return 'שלשום ' + time
  return new Intl.DateTimeFormat('he-IL', { dateStyle: 'full', timeStyle: 'short' }).format(date)
}

export function initials(chat) {
  return (chat?.name || chat?.jid || '?').slice(0, 2)
}

// Global cache: true = has avatar, false = no avatar, undefined = unknown
const avatarCache = {}

export function setAvatarCache(jid, hasAvatar) {
  avatarCache[jid] = hasAvatar
}

export function getAvatarCache(jid) {
  return avatarCache[jid]
}

export function avatarUrl(chat, botId, large = false) {
  if (!chat?.jid || !botId) return ''
  if (avatarCache[chat.jid] === false) return ''
  const size = large ? 'large' : 'default'
  return `/api/avatar?size=${size}&v=${AVATAR_VERSION}&bot=${encodeURIComponent(botId)}&jid=${encodeURIComponent(chat.jid)}`
}

// Bump this whenever avatar caching changes to force the browser to
// refetch from the server instead of a stale cached (resized) copy.
export const AVATAR_VERSION = '4'

