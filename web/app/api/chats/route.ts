import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { currentUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!await currentUserId()) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    // A group is called by its subject. A person is called what the phone's
    // address book calls them, before anything they chose for themselves.
    const { rows } = await getPool().query(
      `SELECT c.chat_id AS id, c.is_group AS "isGroup", c.last_message_at AS "lastMessageAt",
              CASE WHEN c.is_group THEN c.name ELSE COALESCE(ct.name, c.name, ct.notify) END AS name,
              m.kind, m.body, m.deleted, m.from_me AS "fromMe",
              COALESCE(sender.name, m.sender_name, sender.notify) AS "senderName"
       FROM whatsapp_chats c
       LEFT JOIN whatsapp_contacts ct ON ct.jid = c.chat_id
       LEFT JOIN LATERAL (
         SELECT * FROM whatsapp_messages WHERE chat_id = c.chat_id ORDER BY sent_at DESC, id DESC LIMIT 1
       ) m ON TRUE
       LEFT JOIN whatsapp_contacts sender ON sender.jid = m.sender_jid
       WHERE c.last_message_at IS NOT NULL
       ORDER BY c.last_message_at DESC
       LIMIT 500`
    );
    return NextResponse.json(rows, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
