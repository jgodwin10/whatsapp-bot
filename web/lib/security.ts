import crypto from "node:crypto";

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString("base64url")) {
  return new Promise<string>((resolve, reject) => crypto.scrypt(password, salt, 64, (error, derived) => error ? reject(error) : resolve(`scrypt.${salt}.${derived.toString("base64url")}`)));
}

export async function verifyPassword(password: string, stored: string) {
  const [kind, salt, expected] = stored.split(".");
  if (kind !== "scrypt" || !salt || !expected) return false;
  const actual = await hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(stored));
}

export const tokenHash = (token: string) => crypto.createHash("sha256").update(token).digest("base64url");
export const newToken = () => crypto.randomBytes(32).toString("base64url");
