import { getContentType, normalizeMessageContent, WAMessageStatus, WAMessageStubType } from "@whiskeysockets/baileys";

// WhatsApp delivers these as messages, but nobody wrote them.
const nonConversationTypes = new Set([
  "protocolMessage", "reactionMessage", "encReactionMessage", "pollUpdateMessage",
  "encEventResponseMessage", "keepInChatMessage", "pinInChatMessage", "stickerSyncRmrMessage",
]);
const kinds = {
  imageMessage: "image", videoMessage: "video", ptvMessage: "video", stickerMessage: "sticker", documentMessage: "document",
  contactMessage: "contact", contactsArrayMessage: "contact", locationMessage: "location", liveLocationMessage: "location",
  pollCreationMessage: "poll", pollCreationMessageV2: "poll", pollCreationMessageV3: "poll",
};

function messageBody(message) {
  const content = normalizeMessageContent(message);
  return content?.conversation
    || content?.extendedTextMessage?.text
    || content?.imageMessage?.caption
    || content?.videoMessage?.caption
    || content?.documentMessage?.caption
    || content?.documentMessage?.fileName
    || content?.contactMessage?.displayName
    || content?.contactsArrayMessage?.displayName
    || content?.locationMessage?.name
    || content?.pollCreationMessage?.name
    || content?.pollCreationMessageV2?.name
    || content?.pollCreationMessageV3?.name
    || null;
}

function messageKind(message) {
  const content = normalizeMessageContent(message);
  const type = getContentType(content);
  if (type === "conversation" || type === "extendedTextMessage") return "text";
  if (type === "audioMessage") return content.audioMessage.ptt ? "voice" : "audio";
  return kinds[type] ?? "other";
}

function contextInfo(message) {
  const content = normalizeMessageContent(message);
  const type = getContentType(content);
  return type && type !== "conversation" ? content[type]?.contextInfo : undefined;
}

function timestampSeconds(message) {
  const timestamp = message.messageTimestamp;
  const value = typeof timestamp === "number" ? timestamp : Number(timestamp?.toString?.() ?? timestamp);
  return Number.isFinite(value) && value > 0 ? value : Date.now() / 1000;
}

// Pending and failed sends have no tick to show, so only these steps are kept.
function deliveryStatus(status) {
  return status >= WAMessageStatus.SERVER_ACK && status <= WAMessageStatus.PLAYED ? status : null;
}

export function isConversationMessage(message) {
  const type = getContentType(normalizeMessageContent(message?.message));
  return Boolean(type) && !nonConversationTypes.has(type);
}

// Statuses and channels are broadcasts, not chats with this account.
export function isReadableChat(jid, ignoredChats = new Set()) {
  return typeof jid === "string"
    && !jid.endsWith("@broadcast")
    && !jid.endsWith("@newsletter")
    && !ignoredChats.has(jid);
}

export function createMessageStore({ query, ignoredChats = new Set() }) {
  const phoneByLid = new Map();

  async function rememberPhone(lid, phoneJid) {
    if (phoneByLid.get(lid) === phoneJid) return;
    phoneByLid.set(lid, phoneJid);
    await query(
      `INSERT INTO whatsapp_contacts (jid, phone_jid) VALUES ($1, $2)
       ON CONFLICT (jid) DO UPDATE SET phone_jid = EXCLUDED.phone_jid`,
      [lid, phoneJid],
      "contact phone update",
    );
  }

  // WhatsApp can address one person by number or by @lid. Using the number when
  // it is known keeps their messages in one conversation instead of two.
  async function phoneJidFor(jid, phoneHint) {
    if (!jid?.endsWith("@lid")) return jid ?? null;
    if (phoneHint) {
      await rememberPhone(jid, phoneHint);
      return phoneHint;
    }
    if (phoneByLid.has(jid)) return phoneByLid.get(jid);
    const { rows } = await query("SELECT phone_jid FROM whatsapp_contacts WHERE jid = $1", [jid], "contact phone lookup");
    if (!rows[0]?.phone_jid) return jid;
    phoneByLid.set(jid, rows[0].phone_jid);
    return rows[0].phone_jid;
  }

  const chatIdFor = (key) => phoneJidFor(key.remoteJid, key.senderPn);

  async function saveMessage(message) {
    const { key } = message;
    if (!key.id || !isReadableChat(key.remoteJid, ignoredChats) || !isConversationMessage(message)) return false;
    if (key.remoteJid.endsWith("@s.whatsapp.net") && key.senderLid) await rememberPhone(key.senderLid, key.remoteJid);
    const chatId = await chatIdFor(key);
    if (!isReadableChat(chatId, ignoredChats)) return false;
    const isGroup = chatId.endsWith("@g.us");
    const senderJid = key.fromMe ? null : isGroup ? await phoneJidFor(key.participant, key.participantPn) : chatId;
    const senderName = key.fromMe ? null : message.pushName || null;
    if (senderJid && senderName) {
      await query(
        `INSERT INTO whatsapp_contacts (jid, notify) VALUES ($1, $2)
         ON CONFLICT (jid) DO UPDATE SET notify = EXCLUDED.notify`,
        [senderJid, senderName],
        "contact name update",
      );
    }
    const context = contextInfo(message.message);
    const quotedBody = context?.quotedMessage
      ? messageBody(context.quotedMessage) ?? `[${messageKind(context.quotedMessage)}]`
      : null;
    const sentAt = timestampSeconds(message);
    // Group receipts are per participant and aren't tracked, so a group message
    // gets no ticks rather than one stuck on "sent".
    const status = key.fromMe && !isGroup ? deliveryStatus(message.status) : null;
    const { rowCount } = await query(
      `WITH chat AS (
         INSERT INTO whatsapp_chats (chat_id, is_group, last_message_at) VALUES ($1, $2, $9)
         ON CONFLICT (chat_id) DO UPDATE SET
           last_message_at = GREATEST(whatsapp_chats.last_message_at, EXCLUDED.last_message_at)
       )
       INSERT INTO whatsapp_messages
         (chat_id, message_id, sender_jid, sender_name, from_me, kind, body, quoted_sender_jid, quoted_body, sent_at, status)
       VALUES ($1, $3, $4, $5, $6, $7, $8, $10, $11, $9, $12)
       ON CONFLICT (chat_id, message_id) DO UPDATE SET status = EXCLUDED.status
       WHERE EXCLUDED.status > COALESCE(whatsapp_messages.status, 0)`,
      [chatId, isGroup, key.id, senderJid, senderName, Boolean(key.fromMe), messageKind(message.message), messageBody(message.message),
        sentAt, context?.quotedMessage ? await phoneJidFor(context.participant) : null, quotedBody, status],
      "message insert",
    );
    return rowCount > 0;
  }

  // A message deleted for everyone is only marked deleted: its text and media
  // label stay so the web app can still show it, flagged as deleted.
  // Other updates are ignored.
  async function applyMessageUpdate({ key, update }) {
    if (!key?.id || !isReadableChat(key.remoteJid, ignoredChats)) return;
    const chatId = await chatIdFor(key);
    // Baileys can merge a receipt and an edit into one update, so this comes first.
    const status = deliveryStatus(update.status);
    if (status !== null) {
      // Receipts can arrive out of order, so a message never moves backwards.
      // A person may read from an @lid this bridge can't link to their number yet,
      // while the message is saved under the number: then only the id can match.
      await query(
        `UPDATE whatsapp_messages SET status = GREATEST(status, $3)
         WHERE message_id = $2 AND from_me AND chat_id NOT LIKE '%@g.us'
           AND (chat_id = $1 OR $1 LIKE '%@lid')`,
        [chatId, key.id, status],
        "message status update",
      );
    }
    if (update.messageStubType === WAMessageStubType.REVOKE) {
      await query(
        "UPDATE whatsapp_messages SET deleted = TRUE WHERE chat_id = $1 AND message_id = $2",
        [chatId, key.id],
        "message delete",
      );
      return;
    }
    if (!update.message?.editedMessage) return;
    const body = messageBody(update.message);
    if (body === null) return;
    await query(
      "UPDATE whatsapp_messages SET body = $3, edited = TRUE WHERE chat_id = $1 AND message_id = $2",
      [chatId, key.id, body],
      "message edit",
    );
  }

  async function saveContacts(contacts) {
    for (const contact of contacts) {
      const phoneJid = contact.jid ?? (contact.id?.endsWith("@s.whatsapp.net") ? contact.id : null);
      const jids = new Set([contact.id, contact.lid, contact.jid].filter((jid) => jid && !jid.endsWith("@g.us")));
      for (const jid of jids) {
        await query(
          `INSERT INTO whatsapp_contacts (jid, name, notify, phone_jid) VALUES ($1, $2, $3, $4)
           ON CONFLICT (jid) DO UPDATE SET
             name = COALESCE(EXCLUDED.name, whatsapp_contacts.name),
             notify = COALESCE(EXCLUDED.notify, whatsapp_contacts.notify),
             phone_jid = COALESCE(EXCLUDED.phone_jid, whatsapp_contacts.phone_jid)`,
          [jid, contact.name || null, contact.notify || null, jid.endsWith("@lid") ? phoneJid : null],
          "contact upsert",
        );
      }
    }
  }

  // Also takes WhatsApp's group metadata, whose name is called `subject`.
  async function saveChatNames(chats) {
    for (const chat of chats) {
      const name = chat.subject || chat.name;
      if (!name || !isReadableChat(chat.id, ignoredChats)) continue;
      await query(
        `INSERT INTO whatsapp_chats (chat_id, is_group, name) VALUES ($1, $2, $3)
         ON CONFLICT (chat_id) DO UPDATE SET name = EXCLUDED.name`,
        [await phoneJidFor(chat.id), chat.id.endsWith("@g.us"), name],
        "chat name upsert",
      );
    }
  }

  return { saveMessage, applyMessageUpdate, saveContacts, saveChatNames };
}
