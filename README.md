# WhatsApp Chat Reader

Reads every chat on your WhatsApp account (groups and DMs) and shows them in a private web app laid out like a chat app, with the name of whoever sent each message. It is read-only: it never sends anything.

- `whatsapp-bridge/` links to your account as a WhatsApp linked device and saves messages to Postgres.
- `web/` is the Next.js chat interface.

## Run it on your computer

You need Node 20 and a Postgres database (Supabase, Neon or local). Create a new database for this; don't reuse one that holds anything else.

```bash
# Terminal 1: reads WhatsApp. Run this first, because it creates the tables.
cd whatsapp-bridge
cp .env.example .env        # then set DATABASE_URL
nvm use && npm install && npm start

# Terminal 2: the chat interface
cd web
cp .env.example .env.local  # then set the same DATABASE_URL
npm install && npm run dev
```

Open http://localhost:3000, create your account, and scan the QR code from WhatsApp → Settings → Linked devices.

## Deploy it

1. Deploy `whatsapp-bridge/` with `render.yaml` (or anywhere that runs a long-lived Docker container). `.wwebjs_auth` must be on persistent storage, or you will have to scan again after every deploy.
2. Deploy `web/` to Vercel with `DATABASE_URL`.
3. **Create your account straight away.** Only the first account can register, and it can read all your messages and see the pairing QR.

## What gets read

- **New messages:** every group and DM, including the ones you send from your phone.
- **Older messages:** only what WhatsApp sends when you link, normally recent history. To ask for everything, set `WHATSAPP_SYNC_FULL_HISTORY=true` **before** scanning. A long-used account can take a long time and a lot of database space.
- **Photos, videos and voice notes:** shown as a label with any caption. The files aren't downloaded.
- **Edits and deletions:** these show the same way they do on your phone, and the text of a deleted message isn't kept.
- **Ticks on your messages:** in DMs, your messages show ✓ sent, ✓✓ delivered and blue ✓✓ read, like on your phone. If the other person has read receipts turned off, they never turn blue. Group messages don't show ticks, and neither do messages saved before this was added until a new receipt arrives.
- **Not read:** statuses, channels, and anything listed in `WHATSAPP_IGNORED_CHATS`.
- **One tick for senders:** the bridge withholds its delivery receipt by default. WhatsApp can retry an incoming message, but duplicate saves are safely ignored. Set `WHATSAPP_SUPPRESS_DELIVERY_RECEIPTS=false` if that affects reliability for your account.

Messages are kept until you delete them, unless you set `WHATSAPP_MESSAGE_RETENTION_DAYS`. Linking stays active on your phone until you remove it under Linked devices.

## Names

Each message shows the name saved in your address book if WhatsApp has shared it, otherwise the name the person set for themselves, otherwise their number. Saved names can take a while to arrive after linking.

## Privacy

Your database holds your private messages, including ones other people sent you, in plain text. Keep `DATABASE_URL` and your password to yourself.

## Troubleshooting

- **The app says Offline:** check the bridge logs. If the phone removed the linked device, a new QR code appears in the app.
- **Logs repeatedly show `Bad MAC` or `No matching sessions found`:** set `WHATSAPP_RESET_AUTH_ON_START=true`, restart, scan the new QR code, then set it back to `false` straight away. Saved messages are kept.
- **Node:** the bridge is tested on Node 20.

## Tests

`cd whatsapp-bridge && TEST_DATABASE_URL=postgresql://... npm test`. Use a throwaway database, because the tests empty its message tables. Without `TEST_DATABASE_URL`, the database tests are skipped.
