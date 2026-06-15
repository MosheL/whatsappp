import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isForwardedMessage, messageLinkPreview, messagePatchFromContent, quotedFromIncomingMessage, unwrapMessageForMedia } from '../src/message-processor.ts'

test('detects and preserves forwarded message metadata', () => {
  const content: any = {
    extendedTextMessage: {
      text: 'forwarded text',
      contextInfo: { forwardingScore: 1 }
    }
  }

  assert.equal(isForwardedMessage(content), true)
  assert.equal(messagePatchFromContent(content).forwarded, true)
})

test('preserves quoted media as media instead of exposing its protocol type', () => {
  const quoted = quotedFromIncomingMessage({
    key: { id: 'outer' },
    message: {
      extendedTextMessage: {
        text: 'reply',
        contextInfo: {
          stanzaId: 'quoted',
          participant: '972501234567@s.whatsapp.net',
          quotedMessage: { imageMessage: { mimetype: 'image/jpeg' } }
        }
      }
    }
  } as any)

  assert.equal(quoted?.text, '')
  assert.equal(quoted?.mediaKind, 'image')
})

test('extracts link preview metadata from extended text messages', () => {
  const preview = messageLinkPreview({
    extendedTextMessage: {
      text: 'https://example.com',
      matchedText: 'https://example.com',
      title: 'Example',
      description: 'Example description',
      jpegThumbnail: Buffer.from('image')
    }
  })

  assert.equal(preview?.url, 'https://example.com')
  assert.equal(preview?.title, 'Example')
  assert.match(preview?.thumbnail || '', /^data:image\/jpeg;base64,/)
})

test('normalizes directPath-only media for the Baileys media downloader', () => {
  const original: any = {
    key: { id: 'image-1' },
    message: {
      ephemeralMessage: {
        message: {
          imageMessage: {
            directPath: '/v/t62.7118-24/image.enc',
            mediaKey: Buffer.from('key')
          }
        }
      }
    }
  }

  const normalized: any = unwrapMessageForMedia(original)

  assert.equal(normalized.message.imageMessage.directPath, '/v/t62.7118-24/image.enc')
  assert.equal(normalized.message.imageMessage.url, '')
  assert.equal('url' in original.message.ephemeralMessage.message.imageMessage, false)
})
