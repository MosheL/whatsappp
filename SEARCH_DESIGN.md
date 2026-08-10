# Message Content Search — Design

Goal: search the **content** of messages **on the server** (not just the
chats/messages currently loaded in the browser), and show the results in a
**draggable + resizable floating popup** so the chat and the search can be used
at the same time.

Clicking a search result **does not open the main chat**. Instead it loads a
**block of messages around the match** (before + after) *inside the popup*, so
you can read the context. From that block you can **reply** (inline composer) and
**drag** a message (forward it onto a sidebar chat) — without ever leaving the
search popup.

---

## 1. Why server-side?

The client only holds:
- the chat list (names + last-message preview)
- the messages of the *currently open* chat (≈200, newest first)

So a client-side search can only see what is already on screen. The server,
however, persists every stored message in Redis (per chat, newest `STORED_MESSAGE_LIMIT`
kept). Searching the server covers **all chats × all stored messages**, including
chats that are not open and messages that were never loaded into the browser.

---

## 2. Backend

### 2.1 Data layout (already in place)

Per bot (`authKey`):

| What | Key | Type |
|------|-----|------|
| chat list | `ui:{authKey}:chat-index` | sorted set: `jid` by timestamp |
| chat data | `ui:{authKey}:chats` | hash: `jid -> JSON(UiChat)` |
| message ids of a chat | `ui:{authKey}:message-index:{jid}` | sorted set: `id` by timestamp |
| message payload | `ui:{authKey}:message:{base64(jid:id)}` | string JSON(UiMessage) |

`UiMessage.text` is the primary searchable field.

### 2.2 New bot methods

#### `Bot.searchMessages(query, opts)`

```
searchMessages(query, { chatJid?, limit = 50, maxScan = 5000 })
```

Algorithm (bounded, recent-biased):

1. Normalize the query: `q = query.trim().toLowerCase()`. Return `[]` if empty.
2. Determine candidate chat jids:
   - If `chatJid` given → just `[canonicalJid(chatJid)]` (search inside one chat).
   - Else → `redis.zrevrange(chatIndexKey, 0, -1)` (all chats, newest first).
3. Iterate chats. For each chat:
   - If `matches.length >= limit` or `scanned >= maxScan` → stop.
   - `ids = redis.zrevrange(messageIndexKey(jid), 0, 500)` (newest 500 per chat).
   - `raw = redis.mget(...payloadKey(jid, id))`.
   - `scanned += ids.length`.
   - Parse each payload; if `msg.text?.toLowerCase().includes(q)` → collect a
     lightweight result: `{ jid, id, text, sender, fromMe, timestamp, type }`
     (no `raw`, no media bytes — `publicMessage` already strips `raw`).
   - Stop the inner loop once we reach `limit` matches.
4. Sort matches by `timestamp` desc.
5. Enrich with chat metadata: `redis.hmget(chatCacheKey, ...uniqueJids)` and
   attach `{ chatName, displayJid, isGroup }` from the stored `UiChat`.
6. Return `{ results, truncated: scanned >= maxScan }`.

#### `Bot.getMessagesAround(jid, messageId, limit = 40)`

Returns a contiguous block of **full** messages around an anchor message, so the
popup can show the surrounding context of a search hit.

```
getMessagesAround(jid, messageId, limit = 40)
  -> { messages: UiMessage[] (ascending, includes anchor), hasOlder: bool, hasNewer: bool }
```

1. `jid = canonicalJid(jid)`; fetch the anchor via `messageStore.getStoredMessage`.
   If not found → `{ messages: [], hasOlder: false, hasNewer: false }`.
2. `half = ceil(limit/2)`, `ts = anchor.timestamp`.
3. Older: `zrevrangebyscore(messageIndexKey(jid), '(ts', '-inf', LIMIT 0, half)` →
   newest-first; reverse to ascending.
4. Newer: `zrangebyscore(messageIndexKey(jid), '(ts', '+inf', LIMIT 0, half)` →
   ascending.
5. `ids = [...olderIds, messageId, ...newerIds]`; load payloads; `publicMessage`
   each; sort ascending.
6. `hasOlder = zcount(key, '-inf', '(ts') > half`; `hasNewer = zcount(key, '(ts', '+inf') > half`.

Exclusive score bounds `(ts` are consistent with the existing `before` pagination.

#### `Bot.getMessages(jid, limit, before?, after?)` — add `after`

The existing method gains an `after` parameter so the popup can page *newer*
messages (load-more-newer):

- `after` set → `zrangebyscore(key, '(after', '+inf', LIMIT 0, limit)` (ascending).
- `before` set → existing `zrevrangebyscore` (unchanged).
- neither → newest `limit` (unchanged).

Why these caps:
- `limit` (default 50) bounds the payload we send to the client.
- `maxScan` (default 5000) bounds how many payloads we parse per request so a
  huge history can't freeze the event loop. `zrevrange` newest-first + recency
  ordering of chats means recent matches win, which is what users expect.

### 2.3 New / changed HTTP routes

All under the existing `/api/*` session auth.

#### `GET /api/search?bot=&q=&limit=&chat=`

```json
{
  "results": [
    {
      "jid": "972...@s.whatsapp.net",
      "id": "3EB0...",
      "text": "...full text...",
      "sender": "Moshe",
      "fromMe": false,
      "timestamp": 1700000000,
      "type": "conversation",
      "chatName": "Moshe",
      "displayJid": "972...",
      "isGroup": false
    }
  ],
  "truncated": false
}
```

The full `text` is returned so the client can build a highlighted snippet.
`raw`/`media` are NOT returned — search rows are read-only previews.
`truncated` lets the UI hint "refine your query".

#### `GET /api/messages-around?bot=&jid=&id=&limit=`

Returns the context block: `{ messages: [...], hasOlder, hasNewer }`.

#### `GET /api/messages?bot=&jid=&limit=&before=&after=`

`after` is a new optional query param (see `getMessages` above). `before` is
unchanged. Used by the popup for load-older / load-newer paging.

---

## 3. Frontend

### 3.1 New component `web/src/SearchPopup.vue`

A **floating window** (not a modal — no mask, does not block the chat). It has
two internal views:

#### View A — search results

```
┌─────────────────────────────────────┐
│ ⠿ חיפוש בהודעות              ✕   │  ← draggable header (⠿ = move grip)
├─────────────────────────────────────┤
│ [ חיפוש...                ]        │
├─────────────────────────────────────┤
│ Moshe · 12:30                       │
│ ...the <mark>match</mark> snippet…  │
│─────────────────────────────────────│
│ Group name · אתמול                  │
│ ...another <mark>match</mark>…      │
│ ...                                 │
└─────────────────────────────────────┘
                                  ◢  ← resize handle (bottom corner)
```

Clicking a result switches to View B for that message's chat.

#### View B — context block (around the clicked result)

```
┌─────────────────────────────────────┐
│ ⠿ ‹ חזרה לתוצאות   <chat name>  ✕ │
├─────────────────────────────────────┤
│ [טען ישן יותר]                     │  ← load older (if hasOlder)
│ ┄ message N-2 ┄                     │
│ ┄ message N-1 ┄                     │
│ ▶ message (the match, highlighted)  │
│ ┄ message N+1 ┄                     │
│ [טען חדש יותר]                     │  ← load newer (if hasNewer)
├─────────────────────────────────────┤
│ [reply strip to: sender — preview]  │  ← shown when replying
│ [ הודעה ............... ] [שלח]   │  ← inline reply composer
└─────────────────────────────────────┘
```

- The block is fetched via `/api/messages-around` and rendered with the same
  helpers as the main thread (`formatMessageText`, media load via `/api/media`,
  labels for contact/location/call/interactive types).
- **Load older** → `/api/messages?before=<oldestTs>&limit=20`, prepend.
- **Load newer** → `/api/messages?after=<newestTs>&limit=20`, append.
  The older/newer buttons are shown/hidden from the `hasOlder`/`hasNewer` flags
  (initial) and from "returned a full page" (paging).
- **Reply** → inline composer; `POST /api/send { bot, jid, text, quotedId,
  quotedJid }`; the returned message is appended to the block and the main chat
  stays untouched (the WebSocket keeps the main view in sync if it happens to be
  open on that chat).
- **Drag** → each bubble has a drag handle that sets
  `application/x-whatsapp-forward` (same payload as the main thread), so dropping
  it on a sidebar chat forwards it via the existing `onChatDrop` flow.
- The match row is highlighted/scrolled into view on entry.

#### Window behavior (both views)

- **Position**: `position: fixed`, default bottom-right, above the app
  (`z-index: 9000`, below the modal masks at 10000).
- **Draggable**: `mousedown` on the header → `mousemove` updates `left/top`
  (constrained to the viewport).
- **Resizable**: a corner handle → `mousemove` updates `width/height`
  (min `320×360`).
- **Persisted**: `left/top/width/height` saved to `localStorage`
  (`wa-ui-search-window`).
- **Input**: debounced 350ms, min 2 chars before querying.
- **Results**: simple list (capped at 50 rows). Each row shows chat name,
  sender, time, and a snippet of the text with the match highlighted (`<mark>`),
  truncated to ~120 chars around the first match.
- **Loading / empty / error** states.

Props: `selectedBot`. Emits: `close`.

The popup is self-contained: it calls the `/api/*` endpoints directly. It does
NOT switch the main chat on click — that is the whole point. The main chat keeps
working underneath.

### 3.2 App.vue wiring

- A new toggle button (🔍 in the topbar next to logout) sets `showSearchPopup`.
- `<SearchPopup v-if="showSearchPopup" :selected-bot="selectedBot"
   @close="showSearchPopup = false" />` teleported to body.

No `open`/`selectChat` wiring is needed — the popup never opens the main chat.

### 3.3 Styling

Add a `.search-popup` block to `style.css`:
- window: white, rounded, shadow, `display:flex; flex-direction:column`.
- header: same green (`#166a5b`) as modal headers for consistency, cursor `move`.
- body: search input on top, scrollable results below.
- result rows: hover highlight, `dir="auto"` for message text.
- `<mark>` highlight: light green/yellow background.
- resize handle: small triangle in the corner, `cursor: nwse-resize`.
- Keep the popup above the chat (`z-index: 9000`) but below modal masks
  (`z-index: 10000`).

---

## 4. Files to change

| File | Change |
|------|--------|
| `src/bot.ts` | add `searchMessages()`, `getMessagesAround()`; add `after` to `getMessages()` |
| `src/index.ts` | add `GET /api/search`, `GET /api/messages-around`; add `after` to `/api/messages` |
| `web/src/SearchPopup.vue` | **new** — draggable/resizable floating window: search results + context block + reply/drag |
| `web/src/App.vue` | 🔍 toggle button + mount `<SearchPopup>` |
| `web/src/style.css` | `.search-popup` styles |
| `test/bot.test.ts` | tests for `searchMessages`, `getMessagesAround`, `getMessages(after)` |

---

## 5. Out of scope (future enhancements)

- Full-text index (RediSearch) for sub-string search across very large histories.
- Search inside media captions / contact names / interactive bodies (v1 searches
  `text` only, which covers the vast majority of real queries).
- Search across all bots at once (v1 is per-bot, matching the rest of the UI).
- Rich rendering of contact/location/interactive messages in the context block
  (v1 shows a label for those; text + media are rendered fully).
