import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { hashPassword, newToken, tokenHash } from "@/lib/security";
import { sessionCookie, sessionDurationSeconds } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();
    const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    if (typeof password !== "string" || password.length < 12) return NextResponse.json({ error: "Password must be at least 12 characters." }, { status: 400 });
    const userId = crypto.randomUUID(), token = newToken(), now = Date.now() / 1000;
    const pool = getPool();
    // This app shows private messages from every chat and the WhatsApp
    // pairing QR, so only the first account to register (the owner) may exist.
    const { rowCount } = await pool.query(
      "INSERT INTO app_users (id, email, password_hash, created_at) SELECT $1::uuid, $2::text, $3::text, $4::double precision WHERE NOT EXISTS (SELECT 1 FROM app_users)",
      [userId, normalized, await hashPassword(password), now],
    );
    if (!rowCount) return NextResponse.json({ error: "Registration is closed." }, { status: 403 });
    await pool.query("INSERT INTO user_sessions (token_hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)", [tokenHash(token), userId, now + sessionDurationSeconds, now]);
    const response = NextResponse.json({ email: normalized }, { status: 201 }); response.cookies.set(sessionCookie(token)); return response;
  } catch (error: any) { return NextResponse.json({ error: error.code === "23505" ? "An account already uses this email." : error.message }, { status: 500 }); }
}
