import { cookies } from "next/headers";
import { getPool } from "@/lib/db";
import { tokenHash } from "@/lib/security";

const cookieName = "chat_reader_session";
export const sessionDurationSeconds = 60 * 60 * 24 * 7;
// Extend a session (DB + cookie) at most once a day while it is being used.
const renewAfterSeconds = 60 * 60 * 24;

export async function currentUserId() {
  const token = cookies().get(cookieName)?.value;
  if (!token) return null;
  const now = Date.now() / 1000;
  const { rows } = await getPool().query(
    "SELECT user_id, expires_at FROM user_sessions WHERE token_hash = $1 AND expires_at > $2",
    [tokenHash(token), now],
  );
  const session = rows[0];
  if (!session) return null;
  let expiresAt = Number(session.expires_at);
  if (expiresAt - now < sessionDurationSeconds - renewAfterSeconds) {
    expiresAt = now + sessionDurationSeconds;
    await getPool().query("UPDATE user_sessions SET expires_at = $1 WHERE token_hash = $2", [expiresAt, tokenHash(token)]);
  }
  // Re-issue the persistent cookie on every authenticated request. Sessions
  // created before the attributes were fixed only ever had a browser-session
  // cookie, which mobile browsers drop whenever they are backgrounded.
  try {
    cookies().set(sessionCookie(token, expiresAt - now));
  } catch {
    // Server Components cannot set cookies; Route Handlers (all callers today) can.
  }
  return session.user_id as string;
}

const baseOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
});

// Attributes must be top-level properties: Next's cookies().set ignores a
// nested `options` object, which silently produced a cookie with no expiry.
export const sessionCookie = (token: string, maxAgeSeconds = sessionDurationSeconds) => ({
  name: cookieName,
  value: token,
  ...baseOptions(),
  // Set both forms of persistence: some mobile browsers are more reliable
  // when an absolute expiry accompanies Max-Age.
  maxAge: Math.floor(maxAgeSeconds),
  expires: new Date(Date.now() + maxAgeSeconds * 1000),
  priority: "high" as const,
});
export const clearSessionCookie = () => ({ name: cookieName, value: "", ...baseOptions(), maxAge: 0, expires: new Date(0) });
