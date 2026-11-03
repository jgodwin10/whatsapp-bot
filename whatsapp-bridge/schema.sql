CREATE TABLE IF NOT EXISTS whatsapp_chats (
  chat_id TEXT PRIMARY KEY, is_group BOOLEAN NOT NULL, name TEXT, last_message_at DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_chats_last_message ON whatsapp_chats (last_message_at DESC NULLS LAST);
-- name is the name saved in the phone's address book; notify is the name the
-- person gave themselves. phone_jid links a privacy-preserving @lid to a number.
CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  jid TEXT PRIMARY KEY, name TEXT, notify TEXT, phone_jid TEXT
);
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id BIGSERIAL PRIMARY KEY, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
  sender_jid TEXT, sender_name TEXT, from_me BOOLEAN NOT NULL DEFAULT FALSE,
  kind TEXT NOT NULL DEFAULT 'text', body TEXT,
  quoted_sender_jid TEXT, quoted_body TEXT,
  edited BOOLEAN NOT NULL DEFAULT FALSE, deleted BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at DOUBLE PRECISION NOT NULL,
  UNIQUE (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_chat_time ON whatsapp_messages (chat_id, sent_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_sent_at ON whatsapp_messages (sent_at);
CREATE TABLE IF NOT EXISTS bridge_status (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), connected BOOLEAN NOT NULL DEFAULT FALSE,
  last_error TEXT, pairing_qr TEXT, updated_at DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS app_users (
  id UUID PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  expires_at DOUBLE PRECISION NOT NULL, created_at DOUBLE PRECISION NOT NULL
);
