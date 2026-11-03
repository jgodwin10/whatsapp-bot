import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { tokenHash } from "@/lib/security";
import { clearSessionCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const token = cookies().get(clearSessionCookie().name)?.value;
    if (token) await getPool().query("DELETE FROM user_sessions WHERE token_hash = $1", [tokenHash(token)]);
    const response = NextResponse.json({ ok: true }); response.cookies.set(clearSessionCookie()); return response;
  } catch (error: any) { return NextResponse.json({ error: error.message }, { status: 500 }); }
}
