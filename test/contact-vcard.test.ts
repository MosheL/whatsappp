import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildContactVcard, looksLikeLidNumber, phoneDigits } from '../src/contact-vcard.ts'

test('builds a WhatsApp-native vCard with waid so the receiver can start a chat', () => {
  assert.equal(
    buildContactVcard('Alice', '972501234567@s.whatsapp.net'),
    'BEGIN:VCARD\nVERSION:3.0\nFN:Alice\nTEL;type=CELL;type=VOICE;waid=972501234567:+972501234567\nEND:VCARD'
  )
})

test('keeps formatted phone numbers as pure digits in waid', () => {
  assert.equal(
    buildContactVcard('Bob', '+972 50-123 4567'),
    'BEGIN:VCARD\nVERSION:3.0\nFN:Bob\nTEL;type=CELL;type=VOICE;waid=972501234567:+972501234567\nEND:VCARD'
  )
})

test('refuses to build a vCard for LID-like numbers or missing fields', () => {
  assert.equal(buildContactVcard('Ghost', '13104096235587@lid'), '')
  assert.equal(buildContactVcard('', '972501234567'), '')
  assert.equal(buildContactVcard('NoPhone', ''), '')
})

test('detects LID-like numbers', () => {
  assert.equal(looksLikeLidNumber('13104096235587'), true)
  assert.equal(looksLikeLidNumber('972501234567@s.whatsapp.net'), false)
  assert.equal(phoneDigits('+972 50-123 4567'), '972501234567')
})
