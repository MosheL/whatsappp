// Shared message utility functions used by both server (chat-store.ts) and client (App.vue)
// Extracted to avoid duplication and ensure consistent behavior

import type { UiMessage } from './types.ts'

/**
 * Rank message status for comparison.
 * Higher rank = "more delivered/read".
 */
export function messageStatusRank(status: number | string | undefined | null): number {
  const value = String(status || '').toLowerCase()
  if (status === 4 || status === 5 || value.includes('read')) return 4
  if (status === 3 || value.includes('deliver')) return 3
  if (status === 2 || value.includes('server_ack')) return 2
  if (status === 1 || value.includes('sent') || value.includes('pending')) return 1
  return 0
}

/**
 * Merge a patch into a message, handling status ranking, user receipts, and reactions.
 */
export function mergeMessagePatch(message: UiMessage, patch: Partial<UiMessage>): UiMessage {
  const next = { ...message, ...patch }
  if ('status' in patch && messageStatusRank(message.status) > messageStatusRank(patch.status)) {
    next.status = message.status
  }
  if (message.userReceipt || patch.userReceipt) {
    const receipts = [...(Array.isArray(message.userReceipt) ? message.userReceipt : [])]
    for (const receipt of Array.isArray(patch.userReceipt) ? patch.userReceipt : []) {
      const userJid = (receipt as any)?.userJid || (receipt as any)?.participant
      const index = userJid ? receipts.findIndex(item => (item as any).userJid === userJid || (item as any).participant === userJid) : -1
      if (index >= 0) receipts[index] = { ...receipts[index], ...receipt }
      else receipts.push(receipt)
    }
    next.userReceipt = receipts
  }
  if (patch.reaction) {
    const reaction = patch.reaction
    const reactions = [...(Array.isArray(message.reactions) ? message.reactions : [])]
    const userJid = reactionUserKey(reaction)
    const index = userJid ? reactions.findIndex(item => reactionUserKey(item) === userJid) : -1
    if (!reaction.text) {
      if (index >= 0) reactions.splice(index, 1)
    } else if (index >= 0) {
      reactions[index] = { ...reactions[index], ...reaction }
    } else {
      reactions.push(reaction)
    }
    next.reactions = reactions
    delete (next as any).reaction
  }
  return next
}

/**
 * Get a unique key for a reaction for deduplication.
 */
export function reactionUserKey(reaction: { userJid?: string; sender?: string; participant?: string } | undefined | null): string {
  if (!reaction) return ''
  if (reaction.userJid === 'me' || reaction.sender === 'אני') return 'me'
  return reaction.userJid || reaction.participant || reaction.sender || ''
}
