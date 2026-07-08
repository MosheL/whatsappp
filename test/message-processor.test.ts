import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isForwardedMessage, isSupportedMessageType, messageLinkPreview, messagePatchFromContent, messageText, messageType, messageInteractiveData, quotedFromIncomingMessage, unwrapMessageForMedia } from '../src/message-processor.ts'

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

test('parses WhatsApp Cloud API cta_url interactive message into a clickable url button', () => {
  // Mirrors how Softel/Cloud API `cta_url` messages arrive via Baileys:
  // an interactiveMessage.nativeFlowMessage with a button whose name is 'cta_url'
  // and whose buttonParamsJson holds { display_text, url }.
  const content: any = {
    interactiveMessage: {
      header: { title: 'https://www.waze.com/ul?ll=32.096334,34.883147' },
      body: { text: '🚚 הגעה *5.7 דק\'*\n*פת ים 121 פוגל*' },
      footer: { text: 'סדרן: משה | 0546713955' },
      nativeFlowMessage: {
        buttons: [
          {
            name: 'cta_url',
            buttonParamsJson: JSON.stringify({
              display_text: 'ניווט ליעד',
              url: 'https://www.waze.com/ul?ll=32.096334,34.883147&navigate=yes&zoom=17'
            })
          }
        ]
      }
    }
  }

  const data = messageInteractiveData(content)
  assert.equal(data?.type, 'interactive')
  assert.equal(data?.body, '🚚 הגעה *5.7 דק\'*\n*פת ים 121 פוגל*')
  assert.equal(data?.footer, 'סדרן: משה | 0546713955')
  assert.equal(data?.title, 'https://www.waze.com/ul?ll=32.096334,34.883147')
  assert.equal(data?.buttons?.length, 1)
  const btn = data?.buttons?.[0]
  assert.equal(btn?.text, 'ניווט ליעד')
  assert.equal(btn?.type, 'url')
  assert.equal(btn?.name, 'cta_url')
  assert.equal(btn?.url, 'https://www.waze.com/ul?ll=32.096334,34.883147&navigate=yes&zoom=17')
})

test('parses WhatsApp Cloud API interactive button (reply buttons) into display-only buttons', () => {
  // Cloud API `interactive.type: "button"` with reply buttons arrives via
  // Baileys as a buttonsMessage. The button label lives in
  // buttonText.displayText (ButtonText proto field 1), the body in contentText,
  // the footer in footerText, and the header text in `text`.
  const content: any = {
    buttonsMessage: {
      text: 'כותרת',
      contentText: '*שלום נהג!\nמנוי בתוקף עד 27/07/2026*',
      footerText: 'כמ-אל | שום קש לא ישבור אותך',
      buttons: [
        { buttonId: 'Instructions', buttonText: { displayText: '📖 הוראות שימוש' }, type: 1 },
        { buttonId: 'BuySubscription', buttonText: { displayText: '💳 רכישת מנוי' }, type: 1 }
      ]
    }
  }

  const data = messageInteractiveData(content)
  assert.equal(data?.type, 'buttons')
  assert.equal(data?.title, 'כותרת')
  assert.equal(data?.body, '*שלום נהג!\nמנוי בתוקף עד 27/07/2026*')
  assert.equal(data?.footer, 'כמ-אל | שום קש לא ישבור אותך')
  assert.equal(data?.buttons?.length, 2)
  assert.equal(data?.buttons?.[0]?.text, '📖 הוראות שימוש')
  assert.equal(data?.buttons?.[0]?.id, 'Instructions')
  assert.equal(data?.buttons?.[0]?.type, 'quick_reply')
  assert.equal(data?.buttons?.[1]?.text, '💳 רכישת מנוי')
  assert.equal(data?.buttons?.[1]?.id, 'BuySubscription')
  // Body text is extracted for the chat-list preview (no more empty / unsupported fallback)
  assert.equal(messageText(content), '*שלום נהג!\nמנוי בתוקף עד 27/07/2026*')
})

test('parses native-flow call_action and copy_code buttons', () => {
  const content: any = {
    interactiveMessage: {
      body: { text: 'פעולות' },
      nativeFlowMessage: {
        buttons: [
          {
            name: 'call_action',
            buttonParamsJson: JSON.stringify({ display_text: 'חייג', phone_number: '972546713955' })
          },
          {
            name: 'copy_code',
            buttonParamsJson: JSON.stringify({ display_text: 'העתק קוד', code: 'ABC123' })
          }
        ]
      }
    }
  }

  const data = messageInteractiveData(content)
  const [callBtn, copyBtn] = data?.buttons || []
  assert.equal(callBtn?.type, 'call')
  assert.equal(callBtn?.phone, '972546713955')
  assert.equal(callBtn?.text, 'חייג')
  assert.equal(copyBtn?.type, 'copy_code')
  assert.equal(copyBtn?.code, 'ABC123')
  assert.equal(copyBtn?.text, 'העתק קוד')
})

test('falls back to button name when buttonParamsJson is missing or invalid', () => {
  const content: any = {
    interactiveMessage: {
      body: { text: 'x' },
      nativeFlowMessage: {
        buttons: [
          { name: 'quick_reply' },
          { name: 'cta_url', buttonParamsJson: 'not-json' }
        ]
      }
    }
  }
  const data = messageInteractiveData(content)
  assert.equal(data?.buttons?.length, 2)
  assert.equal(data?.buttons?.[0]?.text, 'quick_reply')
  assert.equal(data?.buttons?.[0]?.type, 'quick_reply')
  // No display_text -> falls back to name; url missing so still typed as url but no href
  assert.equal(data?.buttons?.[1]?.text, 'cta_url')
  assert.equal(data?.buttons?.[1]?.type, 'url')
  assert.equal(data?.buttons?.[1]?.url, undefined)
})

test('extracts body text from interactiveResponseMessage (CTA button reply)', () => {
  const content: any = {
    interactiveResponseMessage: {
      body: { text: 'ניווט ליעד נלחץ' },
      nativeFlowResponseMessage: { name: 'cta_url', paramsJson: '{"display_text":"ניווט ליעד","url":"https://waze.com/ul?ll=32,34"}' }
    }
  }
  assert.equal(messageText(content), 'ניווט ליעד נלחץ')
  assert.equal(isSupportedMessageType(messageType(content) as string), true)
})

test('isSupportedMessageType flags known renderable types and rejects unknown ones', () => {
  assert.equal(isSupportedMessageType('conversation'), true)
  assert.equal(isSupportedMessageType('imageMessage'), true)
  assert.equal(isSupportedMessageType('interactiveResponseMessage'), true)
  assert.equal(isSupportedMessageType('unknown'), true)
  // Unsupported message types the UI has no dedicated renderer for
  assert.equal(isSupportedMessageType('locationMessage'), false)
  assert.equal(isSupportedMessageType('orderMessage'), false)
  assert.equal(isSupportedMessageType('productMessage'), false)
  assert.equal(isSupportedMessageType('groupInviteMessage'), false)
  assert.equal(isSupportedMessageType('eventMessage'), false)
})
