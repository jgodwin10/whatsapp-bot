import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import { WAMessageStubType } from "@whiskeysockets/baileys";
import { createMessageStore, isConversationMessage, isReadableChat } from "./messages.js";

// Needs a throwaway Postgres: every table is emptied between tests.
const databaseUrl = process.env.TEST_DATABASE_URL;
const group = "111-1@g.us";
const ada = "2348000000001@s.whatsapp.net";
const ben = "2348000000002@s.whatsapp.net";
const adaLid = "99001@lid";

let pool;
let store;
let nextId = 0;

const incoming = (remoteJid, message, { pushName = "Ada", ...key } = {}) => ({
  key: { remoteJid, id: `msg-${nextId += 1}`, fromMe: false, ...key },
  message,
  pushName,
  messageTimestamp: 1_700_000_000 + nextId,
});
const text = (conversation) => ({ conversation });
const messages = async () => (await pool.query(
  "SELECT chat_id, sender_jid, sender_name, from_me, kind, body, quoted_body, edited, deleted FROM whatsapp_messages ORDER BY id",
)).rows;
const row = (fields) => ({ sender_jid: null, sender_name: null, from_me: false, kind: "text", body: null, quoted_body: null, edited: false, deleted: false, ...fields });

before(async () => {
  if (!databaseUrl) return;
  pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  if (!databaseUrl) return;
  await pool.query("TRUNCATE whatsapp_messages, whatsapp_chats, whatsapp_contacts");
  store = createMessageStore({ query: (sql, values) => pool.query(sql, values), ignoredChats: new Set(["333-3@g.us"]) });
});
after(async () => { await pool?.end(); });

const dbTest = (name, fn) => test(name, { skip: databaseUrl ? false : "TEST_DATABASE_URL is not set" }, fn);

dbTest("a DM is saved with who sent it, and their name becomes known", async () => {
  await store.saveMessage(incoming(ada, text("hello")));
  assert.deepEqual(await messages(), [row({ chat_id: ada, sender_jid: ada, sender_name: "Ada", body: "hello" })]);
  const { rows } = await pool.query("SELECT notify FROM whatsapp_contacts WHERE jid = $1", [ada]);
  assert.equal(rows[0].notify, "Ada");
});

dbTest("a group message records the participant as sender, not the group", async () => {
  await store.saveMessage(incoming(group, text("hi all"), { participant: ben, pushName: "Ben" }));
  assert.deepEqual(await messages(), [row({ chat_id: group, sender_jid: ben, sender_name: "Ben", body: "hi all" })]);
  const { rows } = await pool.query("SELECT is_group FROM whatsapp_chats WHERE chat_id = $1", [group]);
  assert.equal(rows[0].is_group, true);
});

dbTest("your own messages are marked as yours and do not take your name as the contact's", async () => {
  await store.saveMessage(incoming(ada, text("on my way"), { fromMe: true, pushName: "Me" }));
  assert.deepEqual(await messages(), [row({ chat_id: ada, from_me: true, body: "on my way" })]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM whatsapp_contacts")).rows[0].n, 0);
});

dbTest("the same message delivered twice is saved once; the same id in two chats is saved twice", async () => {
  const message = incoming(ada, text("once"));
  assert.equal(await store.saveMessage(message), true);
  assert.equal(await store.saveMessage(message), false);
  await store.saveMessage({ ...message, key: { ...message.key, remoteJid: ben } });
  assert.equal((await messages()).length, 2);
});

dbTest("a chat's last activity never moves backwards when older history arrives", async () => {
  await store.saveMessage({ ...incoming(ada, text("new")), messageTimestamp: 2_000 });
  await store.saveMessage({ ...incoming(ada, text("old")), messageTimestamp: 1_000 });
  const { rows } = await pool.query("SELECT last_message_at FROM whatsapp_chats");
  assert.equal(rows[0].last_message_at, 2_000);
});

dbTest("media is saved as its kind with any caption", async () => {
  await store.saveMessage(incoming(ada, { imageMessage: { caption: "beach" } }));
  await store.saveMessage(incoming(ada, { audioMessage: { ptt: true } }));
  await store.saveMessage(incoming(ada, { documentMessage: { fileName: "cv.pdf" } }));
  await store.saveMessage(incoming(ada, { ephemeralMessage: { message: { extendedTextMessage: { text: "vanishing" } } } }));
  assert.deepEqual((await messages()).map(({ kind, body }) => [kind, body]), [
    ["image", "beach"], ["voice", null], ["document", "cv.pdf"], ["text", "vanishing"],
  ]);
});

dbTest("a reply keeps what it was replying to", async () => {
  await store.saveMessage(incoming(group, { extendedTextMessage: { text: "yes", contextInfo: { participant: ben, quotedMessage: text("coming?") } } }, { participant: ada }));
  const { rows } = await pool.query("SELECT quoted_sender_jid, quoted_body FROM whatsapp_messages");
  assert.deepEqual(rows, [{ quoted_sender_jid: ben, quoted_body: "coming?" }]);
});

dbTest("an edit replaces the text and a deletion removes it", async () => {
  const edited = incoming(ada, text("teh"));
  const removed = incoming(ada, text("secret"));
  await store.saveMessage(edited);
  await store.saveMessage(removed);
  await store.applyMessageUpdate({ key: edited.key, update: { message: { editedMessage: { message: text("the") } } } });
  await store.applyMessageUpdate({ key: removed.key, update: { message: null, messageStubType: WAMessageStubType.REVOKE } });
  await store.applyMessageUpdate({ key: edited.key, update: { status: 4 } });
  assert.deepEqual((await messages()).map(({ body, edited: e, deleted }) => [body, e, deleted]), [["the", true, false], [null, false, true]]);
});

dbTest("one person addressed by @lid and by number stays in one chat", async () => {
  await store.saveMessage(incoming(adaLid, text("first"), { senderPn: ada }));
  await store.saveMessage(incoming(adaLid, text("sent from this phone"), { fromMe: true }));
  await store.saveMessage(incoming(ada, text("third")));
  assert.deepEqual((await messages()).map((m) => m.chat_id), [ada, ada, ada]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM whatsapp_chats")).rows[0].n, 1);
});

dbTest("the @lid mapping survives a restart", async () => {
  await store.saveMessage(incoming(adaLid, text("before"), { senderPn: ada }));
  const restarted = createMessageStore({ query: (sql, values) => pool.query(sql, values) });
  await restarted.saveMessage(incoming(adaLid, text("after"), { fromMe: true }));
  assert.deepEqual((await messages()).map((m) => m.chat_id), [ada, ada]);
});

dbTest("saved contact names and group names are stored; a partial update keeps them", async () => {
  await store.saveContacts([{ id: ada, name: "Ada Lovelace", lid: adaLid }]);
  await store.saveContacts([{ id: ada, notify: "ada_l" }]);
  const { rows } = await pool.query("SELECT jid, name, notify, phone_jid FROM whatsapp_contacts ORDER BY jid");
  assert.deepEqual(rows, [
    { jid: ada, name: "Ada Lovelace", notify: "ada_l", phone_jid: null },
    { jid: adaLid, name: "Ada Lovelace", notify: null, phone_jid: ada },
  ]);
  await store.saveChatNames([{ id: group, subject: "Family" }, { id: "333-3@g.us", subject: "Ignored" }]);
  assert.deepEqual((await pool.query("SELECT chat_id, name FROM whatsapp_chats")).rows, [{ chat_id: group, name: "Family" }]);
});

dbTest("ignored chats, statuses and channels are not saved", async () => {
  await store.saveMessage(incoming("333-3@g.us", text("muted")));
  await store.saveMessage(incoming("status@broadcast", text("my holiday")));
  await store.saveMessage(incoming("123@newsletter", text("news")));
  await store.saveMessage(incoming(ada, { reactionMessage: { text: "👍" } }));
  assert.deepEqual(await messages(), []);
});

test("chat filter", () => {
  assert.equal(isReadableChat(group), true);
  assert.equal(isReadableChat(ada), true);
  assert.equal(isReadableChat("status@broadcast"), false);
  assert.equal(isReadableChat(group, new Set([group])), false);
  assert.equal(isReadableChat(undefined), false);
});

test("only messages someone wrote count as conversation", () => {
  assert.equal(isConversationMessage({ message: text("hi") }), true);
  assert.equal(isConversationMessage({ message: { imageMessage: {} } }), true);
  assert.equal(isConversationMessage({ message: { protocolMessage: {} } }), false);
  assert.equal(isConversationMessage({ message: { editedMessage: { message: { protocolMessage: {} } } } }), false);
  assert.equal(isConversationMessage({ message: { senderKeyDistributionMessage: {} } }), false);
  assert.equal(isConversationMessage({ message: null }), false);
});
