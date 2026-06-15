# Live WhatsApp E2E Tests

The live suite uses the running API, two connected WhatsApp bot sessions, and a dedicated test group containing both phones.

1. Create a WhatsApp group used only for tests and add both phones.
2. Start the application normally.
3. Create `.env.e2e` from `.env.e2e.example`.
4. Set `E2E_GROUP_JID` to the group's `jid` from `GET /api/chats?bot=bot1`.
5. Run:

```powershell
npm.cmd run test:e2e
```

The suite verifies:

- Both bot sessions are connected.
- Bot 1 sends a group message and bot 2 receives it.
- Bot 2 replies and bot 1 receives the quoted reply.
- Bot 1 reacts and bot 2 stores the reaction.
- Bot 2 can mark the group read.

Set `E2E_CLEANUP=true` to delete the two test messages after the run. The suite is intentionally excluded from normal `npm test`.
