// vCard helpers shared by the server and the browser bundle.
// Must stay dependency-free: the Vue app imports this module directly.

/** Keep only the digits of a phone number or JID. */
export function phoneDigits(value?: string | null): string {
  return String(value || '').replace(/[^\d]/g, '')
}

/**
 * Heuristic: LIDs are long numeric identifiers that masquerade as phone numbers.
 * 14+ digits not starting with a real Israeli country code are treated as LIDs.
 */
export function looksLikeLidNumber(value?: string): boolean {
  const digits = phoneDigits(value)
  return digits.length >= 14 && !digits.startsWith('972')
}

/**
 * Build a WhatsApp-native vCard.
 *
 * The `waid` (WhatsApp ID) parameter on the TEL line is what the receiving
 * client uses to resolve the contact to an existing WhatsApp account. Without
 * it the receiver shows the number as "not on WhatsApp" and cannot start a chat.
 */
export function buildContactVcard(name: string, phone: string): string {
  const displayName = String(name || '').trim()
  const digits = phoneDigits(phone)
  if (!displayName || !digits || looksLikeLidNumber(digits)) return ''
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${displayName}`,
    `TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}`,
    'END:VCARD'
  ].join('\n')
}
