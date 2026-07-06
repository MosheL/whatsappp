# WhatsApp UI Server

A headless WhatsApp client with a web UI, built on [Baileys](https://github.com/WhiskeySockets/baileys) (WhatsApp Web protocol implementation). Uses Redis for state persistence and serves a Vue 3 frontend.

## Architecture

```
whatsapp/
├── src/                    # Server-side (Node.js, TypeScript)
│   ├── index.ts            # HTTP server, routing, WebSocket
│   ├── bot.ts              # Core bot logic (Baileys connection, message processing)
│   ├── contact-cache.ts    # Contact/LID cache, presence/typing, sender display
│   ├── message-store.ts    # Message persistence in Redis
│   ├── message-processor.ts# Pure message parsing utilities
│   └── chat-store.ts       # Chat cache, message patching, call events
├── web/src/                # Client-side (Vue 3)
│   ├── App.vue             # Root component
│   ├── ChatList.vue        # Chat list sidebar
│   ├── ChatThread.vue      # Message thread view
│   ├── helpers.js          # Formatting utilities
│   ├── main.js             # Vue app entry
│   └── composables/        # Vue composables
├── test/                   # Tests
│   ├── api.test.ts         # API endpoint tests
│   ├── contact-cache.test.ts
│   ├── message-store.test.ts
│   ├── e2e.live.test.ts    # End-to-end live tests
│   └── E2E.md              # E2E test docs
└── web/public/             # Static assets (service worker)
```

### Data flow

```
WhatsApp Web (Baileys)
    ↓ (raw events: messages.upsert, presence.update, contacts.upsert, etc.)
bot.ts
    ├── recordBaileysMessage() → UiMessage
    │   ├── message-processor.ts (parse WA message → text, type, media, interactive data)
    │   ├── contact-cache.ts    (resolve sender name, LID→phone)
    │   └── message-store.ts    (persist to Redis)
    │
    ├── recordUiMessage() → store in memory + emit to UI via WebSocket
    │
    ├── presence.update handler
    │   └── contact-cache.ts (processPresenceData → typing indicator)
    │
    ├── contacts.upsert handler
    │   └── contact-cache.ts (rememberContact → cache + Redis)
    │
    └── chat.upsert handler
        └── chat-store.ts (upsertChatFromBaileys → cache + Redis)

WebSocket → Web UI (Vue)
    ↓
ChatList.vue / ChatThread.vue
    └── helpers.js (formatTime, formatDateFull, formatLastSeen)
```

## Key concepts

### Contacts & LIDs
WhatsApp uses **LID** (Login ID) identifiers (`13104096235587@lid`) alongside phone numbers (`972508849403@s.whatsapp.net`).  
`contact-cache.ts` handles:
- LID→phone mapping (`lidToPhone` Map)
- Reverse lookup: find contact by phone → find its LID
- `rememberContact()` — stores contact under all its IDs, preserves names
- `contactForJid()` — looks up by phone or LID, falls back to reverse LID lookup
- `senderDisplayName()` — resolves sender name for messages (excludes `remoteJid` for groups)
- `processPresenceData()` — typing indicators in groups (shows contact name, not number)

### Messages
- Raw Baileys `WAMessage` → `UiMessage` via `recordBaileysMessage()`
- Stored in Redis as JSON payloads, indexed by timestamp in sorted sets
- `message-store.ts` handles persistence, retrieval, trimming, media caching
- `message-processor.ts` parses message content (text, images, video, audio, documents, view-once, calls, interactive buttons/lists/templates)

#### Text formatting
Outgoing and incoming text is rendered by `web/src/message-renderer.js → formatMessageText()`. The renderer supports:

| Source | Renders as |
| --- | --- |
| `*bold*` | **bold** (`<strong>`) |
| `~struck~` | ~~struck~~ (`<del>`) |
| `*bold ~strike~*` | combined bold + strike |
| `https://example.com` / `www.example.com` | regular http(s) link |
| `wa.me/123…` / `chat.whatsapp.com/CODE` / `whatsapp.com/…` | WhatsApp link, no scheme needed (`href` is rewritten to `https://…`) |
| `user@example.com` | `mailto:` link |
| `@[972501234567\|Alice]` / `@972501234567` | mention (resolved in `App.vue → onMentionClick`) |
| `@someone` (no TLD) | plain mention |

Overlap resolution: emails beat mentions, URLs beat emails, WhatsApp link regex runs independently. The same parser is used by both the message bubble (`ChatThread.vue`) and the chat-list preview (`messagePreview`).

#### Interactive messages
WhatsApp Cloud API / native-flow interactive messages (templates, buttons, lists, and `interactiveMessage`) are parsed by `message-processor.ts → messageInteractiveData()` into an `InteractiveData` block on the `UiMessage`, and rendered by `ChatThread.vue` with clickable buttons. Native-flow buttons carry their payload as a `buttonParamsJson` JSON string; the parser decodes it per button type:

| Button `name` | Parsed into | Rendered as |
| --- | --- | --- |
| `cta_url` | `type: 'url'`, `url`, `display_text` | clickable link opening in a new tab |
| `call_action` | `type: 'call'`, `phone`, `display_text` | `tel:` link |
| `copy_code` | `type: 'copy_code'`, `code`, `display_text` | button that copies `code` to clipboard |
| `quick_reply` | `type: 'quick_reply'`, `id`, `display_text` | disabled button (display only) |

The interactive **body** is rendered through the same `formatMessageText()` parser, so `*bold*`, links, and emails inside the body are formatted. Replies to interactive messages (`interactiveResponseMessage`, e.g. a CTA button tap) are extracted as plain text via `messageText()` and shown as a normal text message.

#### Unsupported messages
Message types the UI has no dedicated renderer for (e.g. `locationMessage`, `orderMessage`, `productMessage`, `groupInviteMessage`, `eventMessage`) are shown as a styled **"הודעה לא נתמכת"** placeholder instead of a blank bubble or a raw type string. Detection lives in `web/src/message-renderer.js → isUnsupportedMessage()`: a message is unsupported only when it has no renderable content (no text, media, contact, `interactiveData`, call, view-once, or link preview) **and** its `type` is outside the supported set. Deleted messages are never flagged (they keep their own placeholder). The server-side chat-list preview (`bot.ts`) likewise falls back to `"הודעה לא נתמכת"` for these messages instead of leaking the raw protobuf type.

### Chats
- `chat-store.ts` manages chat metadata in Redis
- `persistChat()` writes to Redis hash + sorted set for ordering
- `mergeMessagePatch()` applies status updates, receipts, reactions
- `updateChatFromEditedMessage()` updates chat preview (last message text)

### Redis keys
```
ui:{authKey}:contacts              → Hash: jid → JSON contact
ui:{authKey}:chat-index            → SortedSet: jid → timestamp
ui:{authKey}:chat:{jid}            → Hash field
ui:{authKey}:message-index:{jid}   → SortedSet: messageId → timestamp
ui:{authKey}:message:{base64}      → String: JSON UiMessage
ui:{authKey}:media:{base64}        → Buffer: media file bytes
ui:{authKey}:chat-settings-sync    → String: last sync timestamp
ui:{authKey}:group-metadata-fetched:{jid} → NX lock for cache
```

## Running

### Local development
```bash
npm run dev          # Server (auto-restart on file changes)
npm run dev:client   # Vite dev server for UI
```

### Docker
```bash
docker compose up    # Server + Redis + UI
```

### Environment variables
| Variable | Default | Description |
|----------|---------|-------------|
| `WHATSAPP_UI_PASSWORD` | `admin` | Login password for UI |
| `WHATSAPP_UI_SESSION_SECRET` | derived from UI password | Signs the HttpOnly UI session cookie |
| `WHATSAPP_EXTERNAL_API_KEY` | empty | Dedicated `X-API-Key` for external `POST /send`; empty disables it |
| `UI_STORED_MESSAGE_LIMIT` | `0` | Max messages stored per chat in Redis (0 = unlimited) |
| `UI_MEDIA_CACHE_TTL_SECONDS` | `14 days` | Media cache duration |
| `UI_CHAT_SETTINGS_RESYNC_INTERVAL_MS` | `24h` | Chat settings sync interval |
| `UI_HISTORY_SYNC_WAIT_MS` | `120s` | Max wait for full history sync |
| `UI_GROUP_METADATA_CACHE_MS` | `10 min` | Group metadata fetch cache |
| `SYNC_FULL_HISTORY` | `true` | Request full history on connect |
| `WA_QUERY_TIMEOUT_MS` | `180s` | Query timeout |

## API endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/login` | Authenticate with password |
| POST | `/send` | External text send integration; requires `X-API-Key` |
| POST | `/api/sync-messages` | Fetch older messages for a chat |
| POST | `/api/mark-read` | Mark chat as read |
| POST | `/api/mark-all-read` | Mark all chats as read |
| POST | `/api/delete-message` | Delete a message |
| POST | `/api/react-message` | Add/remove reaction |
| POST | `/api/send-file` | Send file/image |
| GET | `/api/media` | Download media by JID + message ID |

UI authentication uses an HttpOnly `SameSite=Strict` cookie. Media, avatar, API,
and WebSocket requests receive it automatically; session tokens are not stored in
browser storage or placed in URLs.

Example external send request:
```bash
curl -X POST http://localhost:3000/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $WHATSAPP_EXTERNAL_API_KEY" \
  -d '{"bot":"bot1","jid":"972501234567@s.whatsapp.net","text":"hello"}'
```

## Module dependencies
```
bot.ts ───┬── contact-cache.ts (contacts, LIDs, presence, sender display)
           ├── message-store.ts (message persistence in Redis)
           ├── message-processor.ts (pure message parsing)
           └── chat-store.ts (chat cache, message patching, call events)
               └── (uses contact-cache.ts and message-processor.ts)
```

## Tests
```bash
npm run test:unit    # Unit tests (contact-cache, message-store)
npm run test:api     # API endpoint tests
npm run test:e2e     # E2E live tests (requires .env.e2e)
```
