import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { currentUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

// The bridge reports in every 30 seconds, so silence this long means it stopped.
const staleAfterSeconds = 90;

export async function GET() {
  try {
    if (!await currentUserId()) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    const { rows } = await getPool().query("SELECT connected, last_error, pairing_qr, updated_at FROM bridge_status WHERE id = TRUE");
    const status = rows[0];
    const fresh = status && Date.now() / 1000 - Number(status.updated_at) < staleAfterSeconds;
    return NextResponse.json({
      connected: Boolean(fresh && status.connected),
      lastError: status?.last_error ?? null,
      pairingQr: fresh ? status.pairing_qr : null,
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
