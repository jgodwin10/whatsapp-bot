import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { newToken, tokenHash, verifyPassword } from "@/lib/security";
import { sessionCookie, sessionDurationSeconds } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();
    const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
    const { rows } = await getPool().query("SELECT id, password_hash FROM app_users WHERE email = $1", [normalized]);
    if (!rows[0] || typeof password !== "string" || !await verifyPassword(password, rows[0].password_hash)) return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
    const token = newToken(), now = Date.now() / 1000;
    await getPool().query("INSERT INTO user_sessions (token_hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)", [tokenHash(token), rows[0].id, now + sessionDurationSeconds, now]);
    const response = NextResponse.json({ ok: true }); response.cookies.set(sessionCookie(token)); return response;
  } catch (error: any) { return NextResponse.json({ error: error.message }, { status: 500 }); }
}
