import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { currentUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

const pageSize = 100;

// Returns the page of messages just older than `beforeId`, or the latest page,
// oldest first.
export async function GET(request: NextRequest) {
  try {
    if (!await currentUserId()) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const chat = request.nextUrl.searchParams.get("chat");
    if (!chat) return NextResponse.json({ error: "chat is required." }, { status: 400 });
    const beforeId = request.nextUrl.searchParams.get("beforeId");
    if (beforeId !== null && !/^\d+$/.test(beforeId)) return NextResponse.json({ error: "beforeId must be a number." }, { status: 400 });
    const { rows } = await getPool().query(
      `SELECT m.id::text AS id, m.from_me AS "fromMe", m.sender_jid AS "senderJid",
              COALESCE(sender.name, m.sender_name, sender.notify) AS "senderName",
              m.kind, m.body, m.edited, m.deleted, m.status, m.sent_at AS "sentAt",
              m.quoted_body AS "quotedBody", m.quoted_sender_jid AS "quotedSenderJid",
              COALESCE(quoted.name, quoted.notify) AS "quotedSenderName"
       FROM whatsapp_messages m
       LEFT JOIN whatsapp_contacts sender ON sender.jid = m.sender_jid
       LEFT JOIN whatsapp_contacts quoted ON quoted.jid = m.quoted_sender_jid
       WHERE m.chat_id = $1 AND ($2::bigint IS NULL OR (m.sent_at, m.id) < (SELECT sent_at, id FROM whatsapp_messages WHERE id = $2::bigint))
       ORDER BY m.sent_at DESC, m.id DESC
       LIMIT $3`,
      [chat, beforeId, pageSize + 1],
    );
    const hasOlder = rows.length > pageSize;
    return NextResponse.json({ messages: rows.slice(0, pageSize).reverse(), hasOlder }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
