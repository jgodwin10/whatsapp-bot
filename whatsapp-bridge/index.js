import "dotenv/config";
import { readFile, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import pg from "pg";
import pino from "pino";
import qrcode from "qrcode-terminal";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { createMessageStore } from "./messages.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const ignoredChats = new Set((process.env.WHATSAPP_IGNORED_CHATS ?? "").split(",").map((jid) => jid.trim()).filter(Boolean));
const messageRetentionDays = Number(process.env.WHATSAPP_MESSAGE_RETENTION_DAYS ?? 0);
const syncFullHistory = /^(1|true|yes|on)$/i.test(process.env.WHATSAPP_SYNC_FULL_HISTORY ?? "false");
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: /sslmode=require|supabase/.test(databaseUrl ?? "") ? { rejectUnauthorized: false } : undefined,
});
const reconnectDelayMs = 5_000;
const maxReconnectDelayMs = 30_000;
const heartbeatMs = 30_000;
const maxDisconnectedMs = Math.max(30, Number(process.env.WHATSAPP_MAX_DISCONNECTED_SECONDS ?? 120)) * 1_000;
const decryptFailureLimit = Math.max(1, Number(process.env.WHATSAPP_DECRYPT_FAILURE_LIMIT ?? 3));
const decryptFailureWindowMs = Math.max(30, Number(process.env.WHATSAPP_DECRYPT_FAILURE_WINDOW_SECONDS ?? 120)) * 1_000;
const resetAuthOnStart = /^(1|true|yes|on)$/i.test(process.env.WHATSAPP_RESET_AUTH_ON_START ?? "false");
// Default to one tick for this read-only bridge. Set this to false only if
// WhatsApp retries make the connection unreliable for a particular account.
const suppressDeliveryReceipts = /^(1|true|yes|on)$/i.test(process.env.WHATSAPP_SUPPRESS_DELIVERY_RECEIPTS ?? "true");
const sessionId = (process.env.WHATSAPP_SESSION_ID ?? "chat-reader").replace(/[^a-zA-Z0-9_-]/g, "_");
const authDirectory = path.join(process.env.WHATSAPP_AUTH_DIR ?? ".wwebjs_auth", `baileys-${sessionId}`);

if (!databaseUrl) throw new Error("DATABASE_URL is required.");

let connectionState = "starting";
let lastConnectionChangeAt = Date.now();
let authState;
let signalRecoveryInProgress = false;
const decryptFailures = new Map();
let loggedOutRecoveryInProgress = false;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function queryWithRetry(query, values, description) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await pool.query(query, values);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await wait(250 * (2 ** (attempt - 1)));
    }
  }
  throw new Error(`${description} failed after 3 attempts: ${lastError?.message ?? lastError}`);
}

const store = createMessageStore({ query: queryWithRetry, ignoredChats });

async function updateBridgeStatus(fields = {}) {
  const hasPairingQr = Object.hasOwn(fields, "pairingQr");
  const hasError = Object.hasOwn(fields, "error");
  await queryWithRetry(
    `INSERT INTO bridge_status (id, connected, last_error, pairing_qr, updated_at)
     VALUES (TRUE, $1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       connected = EXCLUDED.connected,
       last_error = CASE WHEN $5 THEN EXCLUDED.last_error ELSE bridge_status.last_error END,
       pairing_qr = CASE WHEN $6 THEN EXCLUDED.pairing_qr ELSE bridge_status.pairing_qr END,
       updated_at = EXCLUDED.updated_at`,
    [connectionState === "open", fields.error ?? null, fields.pairingQr ?? null, Date.now() / 1000, hasError, hasPairingQr],
    "bridge status update",
  );
}

function persistBridgeStatus(fields) {
  void updateBridgeStatus(fields).catch((error) => {
    console.error("[whatsapp] could not persist bridge status:", error);
  });
}

function pairingQrText(qr) {
  return new Promise((resolve) => qrcode.generate(qr, { small: true }, resolve));
}

async function publishPairingQr(qr) {
  try {
    const renderedQr = await pairingQrText(qr);
    await updateBridgeStatus({ pairingQr: renderedQr, error: null });
    console.log("[whatsapp] pairing QR published to the web app.");
  } catch (error) {
    console.error("[whatsapp] could not publish pairing QR:", error);
  }
}

async function recoverLoggedOutSession() {
  if (loggedOutRecoveryInProgress) return;
  loggedOutRecoveryInProgress = true;
  connectionState = "pairing";
  persistBridgeStatus({
    pairingQr: null,
    error: "WhatsApp removed this linked device. Generating a new QR code.",
  });

  try {
    // `device_removed` credentials cannot be reused. This is deliberately
    // limited to this bridge's generated auth directory; saved messages and any
    // other WhatsApp session are untouched.
    await rm(authDirectory, { recursive: true, force: true });
    authState = undefined;
    console.warn("[whatsapp] removed invalid logged-out auth state; generating a new QR code.");
    await wait(1_000);
    await connect();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[whatsapp] could not reset logged-out auth state:", error);
    persistBridgeStatus({ error: `Could not reset logged-out WhatsApp session: ${detail}` });
  } finally {
    loggedOutRecoveryInProgress = false;
  }
}

function signalSessionKey(jid) {
  // Baileys stores a Signal session as "user:device". A bare JID always
  // addresses device 0, including LID JIDs such as 12345@lid.
  const [userWithDevice] = jid.split("@");
  const [user, device = "0"] = userWithDevice.split(":");
  return user ? `${user}:${device}` : null;
}

async function recoverSignalSession(jid, detail) {
  if (signalRecoveryInProgress || !authState) return;
  const key = signalSessionKey(jid);
  if (!key) return;

  signalRecoveryInProgress = true;
  console.warn(`[whatsapp] a Signal session failed repeatedly (${detail}); clearing its cached key.`);

  try {
    // Do not clear creds.json or the whole auth directory: that would force a
    // QR scan. Crucially, do not end the socket here. A decryption failure in
    // one conversation must never take the listener offline.
    await authState.keys.set({ session: { [key]: null } });
    decryptFailures.delete(jid);
  } catch (error) {
    console.error("[whatsapp] could not reset corrupt Signal session:", error);
  } finally {
    signalRecoveryInProgress = false;
  }
}

function noteDecryptionFailure(jid, detail) {
  if (!jid) return;
  const now = Date.now();
  const previous = decryptFailures.get(jid) ?? [];
  const recent = previous.filter((at) => now - at < decryptFailureWindowMs);
  recent.push(now);
  decryptFailures.set(jid, recent);

  if (recent.length >= decryptFailureLimit) {
    void recoverSignalSession(jid, detail);
  }
}

// Capture decryption failures from every chat. In a group the broken Signal
// session belongs to the participant who sent the message, not to the group.
const baileysLogger = pino({
  level: "warn",
  hooks: {
    logMethod(args, method) {
      const [context, message] = args;
      const detail = context?.err?.message ?? message;
      if (
        context?.key?.remoteJid
        && (context?.err?.type === "SessionError" || /Bad MAC|decrypt message|matching sessions/i.test(detail ?? ""))
      ) {
        noteDecryptionFailure(context.key.participant ?? context.key.remoteJid, detail ?? "decryption failure");
      }
      return method.apply(this, args);
    },
  },
});

function startHealthServer() {
  const port = Number(process.env.PORT);
  if (!port) return;
  const server = http.createServer((_, response) => {
    const connected = connectionState === "open";
    response.writeHead(connected ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: connected ? "ok" : "degraded", whatsapp: connectionState }));
  });
  server.listen(port, "0.0.0.0", () => console.log(`[health] listening on 0.0.0.0:${port}`));
}

// One failed write must not lose the rest of a batch. Message text and names
// stay out of the logs: these are private conversations.
async function saveAll(items, save, what) {
  let failed = 0;
  for (const item of items) {
    try {
      await save(item);
    } catch (error) {
      failed += 1;
      console.error(`[whatsapp] could not save ${what}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return failed;
}

async function saveHistory({ chats = [], contacts = [], messages = [], syncType }) {
  await saveAll([chats], store.saveChatNames, "history chat names");
  await saveAll([contacts], store.saveContacts, "history contacts");
  const failed = await saveAll(messages, store.saveMessage, "a history message");
  console.log(`[whatsapp] history batch (type ${syncType}): ${messages.length} messages, ${failed} failed.`);
}

async function loadGroupNames(activeSocket) {
  try {
    await store.saveChatNames(Object.values(await activeSocket.groupFetchAllParticipating()));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Names are cosmetic; failing to load them must not affect the listener.
    console.warn(`[whatsapp] could not load group names (listener is still active): ${detail}`);
  }
}

async function pruneMessages() {
  if (!(messageRetentionDays > 0)) return;
  try {
    const { rowCount } = await queryWithRetry(
      "DELETE FROM whatsapp_messages WHERE sent_at < $1",
      [Date.now() / 1000 - messageRetentionDays * 86_400],
      "message prune",
    );
    if (rowCount) console.log(`[whatsapp] pruned ${rowCount} messages older than ${messageRetentionDays} days.`);
  } catch (error) {
    console.error("[whatsapp] could not prune messages:", error);
  }
}

let socket;
let reconnectTimer;
let stopping = false;
let reconnectAttempts = 0;

function scheduleReconnect(reason) {
  if (stopping || reconnectTimer) return;
  const delay = Math.min(reconnectDelayMs * (2 ** reconnectAttempts), maxReconnectDelayMs);
  reconnectAttempts += 1;
  console.warn(`[whatsapp] ${reason}; reconnecting in ${delay / 1000}s.`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connect().catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[whatsapp] reconnect failed:", error);
      connectionState = "disconnected";
      lastConnectionChangeAt = Date.now();
      persistBridgeStatus({ error: `WhatsApp reconnect failed: ${detail}` });
      // A failed setup attempt does not emit connection.update, so it must
      // explicitly schedule the next retry instead of waiting for a restart.
      scheduleReconnect("reconnect attempt failed");
    });
  }, delay);
}

async function connect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  const { state, saveCreds } = await useMultiFileAuthState(authDirectory);
  authState = state;
  const { version } = await fetchLatestBaileysVersion();
  socket = makeWASocket({
    auth: state,
    version,
    logger: baileysLogger,
    printQRInTerminal: false,
    // WhatsApp only offers full history to desktop-type devices.
    browser: ["Chat Reader", "Desktop", "1.0.0"],
    // Keep the WebSocket alive through quiet periods and transient network
    // idling by the hosting provider.
    keepAliveIntervalMs: 20_000,
    // Staying offline keeps notifications arriving on the phone as usual.
    markOnlineOnConnect: false,
    // This non-standard Baileys patch suppresses the automatic delivery
    // receipt for incoming messages. WhatsApp may retry messages that it has
    // not been told were delivered.
    suppressDeliveryReceipts,
    syncFullHistory,
    // Baileys' default post-connect queries fetch web-client settings we never
    // use; WhatsApp can time those requests out even though the socket is healthy.
    fireInitQueries: false,
  });

  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("messages.upsert", ({ messages }) => {
    void saveAll(messages, store.saveMessage, "a message");
  });
  socket.ev.on("messages.update", (updates) => {
    void saveAll(updates, store.applyMessageUpdate, "a message update");
  });
  socket.ev.on("messaging-history.set", (history) => void saveHistory(history));
  socket.ev.on("contacts.upsert", (contacts) => void saveAll([contacts], store.saveContacts, "contacts"));
  socket.ev.on("contacts.update", (contacts) => void saveAll([contacts], store.saveContacts, "contacts"));
  socket.ev.on("groups.upsert", (groups) => void saveAll([groups], store.saveChatNames, "group names"));
  socket.ev.on("groups.update", (groups) => void saveAll([groups], store.saveChatNames, "group names"));
  socket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      connectionState = "pairing";
      void publishPairingQr(qr);
    }
    if (connection === "open") {
      connectionState = "open";
      lastConnectionChangeAt = Date.now();
      reconnectAttempts = 0;
      signalRecoveryInProgress = false;
      persistBridgeStatus({ pairingQr: null, error: null });
      console.log("[whatsapp] connected and reading all chats.");
      void loadGroupNames(socket);
      return;
    }
    if (connection !== "close" || stopping) return;

    const code = lastDisconnect?.error?.output?.statusCode;
    connectionState = code === DisconnectReason.loggedOut ? "logged_out" : "disconnected";
    lastConnectionChangeAt = Date.now();
    persistBridgeStatus({ error: `WhatsApp disconnected (${code ?? "unknown"})` });
    if (code === DisconnectReason.loggedOut) {
      console.error("[whatsapp] logged out; resetting invalid auth state for pairing.");
      void recoverLoggedOutSession();
      return;
    }
    scheduleReconnect(`disconnected (${code ?? "unknown"})`);
  });
}

setInterval(() => {
  if (stopping || connectionState === "open") return;
  if (Date.now() - lastConnectionChangeAt < maxDisconnectedMs) return;
  console.error(`[whatsapp] still ${connectionState} after ${maxDisconnectedMs / 1000}s; exiting so the host restarts the bridge.`);
  persistBridgeStatus({ error: `Bridge ${connectionState} for over ${maxDisconnectedMs / 1000}s; restart requested` });
  process.exit(1);
}, 10_000).unref();

// A crashed bridge cannot report that it is offline, so the web app treats a
// status that has stopped updating as offline.
setInterval(() => { if (!stopping) persistBridgeStatus({}); }, heartbeatMs).unref();

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(reconnectTimer);
  socket?.end?.(new Error("service stopping"));
  await pool.end();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await queryWithRetry(await readFile(new URL("./schema.sql", import.meta.url), "utf8"), [], "schema setup");
await pruneMessages();
setInterval(() => void pruneMessages(), 60 * 60 * 1_000).unref();
if (resetAuthOnStart) {
  // Explicit opt-in repair for corrupted Signal/app-state data. Do not enable
  // this permanently: it deliberately requires a new QR pairing on startup.
  console.warn("[whatsapp] WHATSAPP_RESET_AUTH_ON_START is enabled; clearing the bridge auth state for a clean QR pairing.");
  await rm(authDirectory, { recursive: true, force: true });
  connectionState = "pairing";
  await updateBridgeStatus({ pairingQr: null, error: "Bridge auth was reset on startup. Scan the new WhatsApp QR code." });
}
startHealthServer();
await connect();
