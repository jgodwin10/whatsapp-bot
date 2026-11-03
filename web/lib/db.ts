import { Pool } from "pg";

// One connection per Vercel function container. Each serverless container
// has its own pool, so a larger value can exhaust Supabase's session-pool
// client limit even when this app is read-only. Vercel should use the
// Supabase *transaction pooler* URL (port 6543), not the session URL.
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set in the Vercel project's environment variables.");
    }
    pool = new Pool({
      connectionString,
      ssl: connectionString.includes("sslmode=require") || connectionString.includes("neon.tech") || connectionString.includes("supabase")
        ? { rejectUnauthorized: false }
        : undefined,
      max: 1,
      idleTimeoutMillis: 10_000,
    });
  }
  return pool;
}
