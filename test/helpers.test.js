import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatStatusTime, formatTime } from '../web/src/helpers.js'

const now = new Date(2026, 4, 12, 15, 30)

test('status title shows the time for today', () => {
  const today = new Date(2026, 4, 12, 9, 5).getTime()
  assert.equal(formatStatusTime(today, now), formatTime(today))
  assert.match(formatStatusTime(today, now), /^09:05$/)
})

test('status title shows the date for older days', () => {
  const yesterday = new Date(2026, 4, 11, 9, 5).getTime()
  const formatted = formatStatusTime(yesterday, now)
  assert.notEqual(formatted, formatTime(yesterday))
  assert.match(formatted, /\d{1,2}\.\d{1,2}\.\d{2,4}/)
})

test('status title is empty for missing or invalid timestamps', () => {
  assert.equal(formatStatusTime(0, now), '')
  assert.equal(formatStatusTime(undefined, now), '')
  assert.equal(formatStatusTime('not a date', now), '')
})
