# LID → Phone resolution

WhatsApp's multi-device protocol assigns every account a second identity — a
**LID** (`13104096235587@lid`) alongside the classic phone JID
(`972508849403@s.whatsapp.net`). Some chats and most group participants in
"lid addressing mode" (`groupMetadata.addressingMode === 'lid'`) arrive with
LID identifiers only, so the UI has to map them back to phone numbers to show
names, let you open 1:1 chats, and send messages.

All of the logic lives in `src/contact-cache.ts`.

## The two identifiers

| Kind | Example | Where it appears |
| --- | --- | --- |
| Phone JID | `972508849403@s.whatsapp.net` | 1:1 chat jids, `phoneNumber` on contacts, `participantAlt` / `participantPn` / `remoteJidAlt` message-key fields |
| LID | `13104096235587@lid` | group participant ids in lid-mode groups, `key.participant`, sometimes the whole `key.remoteJid` of a 1:1 chat |

A JID may also carry a device suffix (`972508849403:12@s.whatsapp.net`);
`normalizePhoneJid()` strips it back to the base phone JID.

## Storage

- **In memory** — `lidToPhone: Map<lid, phoneJid>` on the bot's `ContactCache`.
- **Redis** — `ui:{authKey}:lid-phone` hash (LID → phone JID), restored into the
  map on startup.
- **Contacts** (`ui:{authKey}:contacts`) are stored **only under phone JIDs** —
  LID-keyed contact entries are deleted, and a contact that carries both ids is
  indexed under all of them.

## How mappings are learned

1. **Passively, from contacts** — `rememberContact()`: whenever a contact sync
   carries both `phoneNumber` and a LID (`id`/`lid`), the pair is written to
   `lidToPhone`, persisted to Redis, and `mergeChatJid(lid, phone)` folds any
   LID-keyed chat into the phone-keyed chat (keeping newest preview/unread).
2. **Actively, via the signal layer** — `resolveLidToPhone(lid)`:
   `sock.signalRepository.lidMapping.getPNForLID(lid)`, then cached in memory +
   Redis + chat merge. Used when a LID shows up with no contact yet (e.g. group
   participant resolution in `bot.ts → groupParticipants`).

## Resolution helpers (the call sites that matter)

| Helper | What it does |
| --- | --- |
| `canonicalJid(jid)` | The chat jid we key everything by: groups pass through untouched; 1:1 jids are translated LID → phone when a mapping exists. |
| `messageRemoteJid(msg)` / `keyRemoteJid(key)` | Chat jid for an incoming message: prefers `remoteJidAlt` (the phone jid) when the primary `remoteJid` is a LID, then `canonicalJid`. |
| `senderDisplayName(key, fallback)` / `senderNumberFromKey(key)` | Sender name/number for group messages: tries `participantAlt` → `participantPn` → `participant` (plus `remoteJidAlt`/`remoteJid` in 1:1 chats), each through `contactForJid` → `canonicalJid` → `lidToPhone`. |
| `shouldIgnoreUiJid(jid)` | `@lid` jids never become chats of their own — they are merged into the phone-jid chat. |
| `resolveOutgoingJid(jid)` | Used by every send API: resolves a LID to a phone JID, and **throws** (`אין מספר טלפון עבור השיחה הזו`) when only a LID is known — you cannot send to a LID. |
| `isOwnJid` / `isOwnMessage` / `isOwnReceipt` | "Me" detection across all id shapes (own phone jid, own LID, device variants). |
| `looksLikeLidNumber` | Heuristic: 14+ digits not starting with `972` are LID-ish numbers, not real phone numbers. |

## Startup restore (`restoreFromRedis`)

1. Load `ui:{authKey}:lid-phone` into `lidToPhone`.
2. Delete LID-keyed entries from the contacts hash, re-index named contacts
   under their phone jids.
3. Every cached chat with a LID jid is merged into its phone-jid chat when a
   mapping exists, otherwise deleted (`cleanupLidUiCache` also drops its
   message store) — an unresolvable LID chat is useless since it can neither be
   opened nor replied to.

## Gotchas

- Group messages in lid-mode groups carry `key.participant` as a LID; the phone
  number may only be available via `participantAlt`/`participantPn` or a cached
  mapping. `bot.ts → groupParticipants()` resolves each participant's phone
  (including an async `resolveLidToPhone` fallback) and matches historical
  message senders to learn names.
- `senderDisplayName` never returns a LID-looking fallback: if the best it has
  is a `@lid` or bare number it falls through to the resolved phone digits.
- Mentions the UI sends (`@[phone|name]`) must be phone jids; in lid groups
  `groupParticipants` maps them to the participant LIDs WhatsApp expects.
