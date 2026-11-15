import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const baileysReceiver = fileURLToPath(new URL(
  "../node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js",
  import.meta.url,
));

const configDestructure = "const { logger, retryRequestDelayMs, maxMsgRetryCount, getMessage, shouldIgnoreJid } = config;";
const patchedConfigDestructure = "const { logger, retryRequestDelayMs, maxMsgRetryCount, getMessage, shouldIgnoreJid, suppressDeliveryReceipts = false } = config;";
const deliveryReceipt = "await sendReceipt(msg.key.remoteJid, participant, [msg.key.id], type);";
const guardedDeliveryReceipt = `if (!suppressDeliveryReceipts || msg.key.fromMe) {
                            ${deliveryReceipt}
                        }`;

let source;
try {
  source = await readFile(baileysReceiver, "utf8");
} catch (error) {
  if (error?.code === "ENOENT") process.exit(0);
  throw error;
}

if (source.includes("suppressDeliveryReceipts = false")) process.exit(0);
if (!source.includes(configDestructure) || !source.includes(deliveryReceipt)) {
  throw new Error("The installed Baileys version has an unrecognised receipt handler; delivery-receipt patch was not applied.");
}

source = source
  .replace(configDestructure, patchedConfigDestructure)
  .replace(deliveryReceipt, guardedDeliveryReceipt);
await writeFile(baileysReceiver, source);
console.log("[whatsapp] delivery-receipt suppression patch applied.");
