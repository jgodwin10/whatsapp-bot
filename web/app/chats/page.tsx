"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

type Chat = {
  id: string; isGroup: boolean; name: string | null; lastMessageAt: number;
  kind: string | null; body: string | null; deleted: boolean | null; fromMe: boolean | null; senderName: string | null;
};
type Message = {
  id: string; fromMe: boolean; senderJid: string | null; senderName: string | null;
  kind: string; body: string | null; edited: boolean; deleted: boolean; sentAt: number;
  quotedBody: string | null; quotedSenderJid: string | null; quotedSenderName: string | null;
};
type Status = { connected: boolean; lastError: string | null; pairingQr: string | null };

const kindLabels: Record<string, string> = {
  image: "📷 Photo", video: "🎥 Video", voice: "🎤 Voice message", audio: "🎵 Audio", sticker: "🏷️ Sticker",
  document: "📄 Document", contact: "👤 Contact", location: "📍 Location", poll: "📊 Poll", other: "Unsupported message",
};
const senderColors = ["#53bdeb", "#ffb86b", "#7ee0a3", "#f28ba8", "#c4a7ff", "#f7d774", "#6fd8d0", "#ff9d8a"];

function hash(value: string) {
  let result = 0;
  for (let i = 0; i < value.length; i++) result = (result * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(result);
}
const colorFor = (value: string) => senderColors[hash(value) % senderColors.length];

// Only a real phone number is shown: a @lid is an opaque id, not a number anyone
// would recognise.
function phoneFrom(jid: string | null) {
  return jid?.endsWith("@s.whatsapp.net") ? `+${jid.split("@")[0]}` : null;
}
const chatName = (chat: Chat) => chat.name || phoneFrom(chat.id) || (chat.isGroup ? "Unnamed group" : "Unknown");
const senderLabel = (message: Message) => message.fromMe ? "You" : message.senderName || phoneFrom(message.senderJid) || "Unknown";

function initials(name: string) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

const time = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function dayLabel(seconds: number) {
  const date = new Date(seconds * 1000);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { day: "numeric", month: "long", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function listTime(seconds: number) {
  const date = new Date(seconds * 1000);
  const label = dayLabel(seconds);
  if (label === "Today") return time(seconds);
  if (label === "Yesterday") return label;
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
}

function preview(chat: Chat) {
  if (chat.deleted) return "This message was deleted";
  const label = chat.kind && chat.kind !== "text" ? kindLabels[chat.kind] ?? kindLabels.other : null;
  const content = chat.body && label ? `${label}: ${chat.body}` : chat.body || label || "";
  if (chat.fromMe) return `You: ${content}`;
  return chat.isGroup && chat.senderName ? `${chat.senderName}: ${content}` : content;
}

function Avatar({ name, id, isGroup }: { name: string; id: string; isGroup: boolean }) {
  return <span className="avatar" style={{ background: colorFor(id) }} aria-hidden="true">{isGroup ? "👥" : initials(name)}</span>;
}

function selectedFromHash() {
  const value = window.location.hash.slice(1);
  try { return value ? decodeURIComponent(value) : null; } catch { return null; }
}

async function getJson(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (response.status === 401) {
    window.location.assign("/login");
    throw new Error("Authentication required.");
  }
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

// Polls while the tab is visible, and straight away on coming back to it.
function usePolling(poll: () => void, intervalMs: number) {
  useEffect(() => {
    poll();
    const id = setInterval(() => { if (!document.hidden) poll(); }, intervalMs);
    const onVisible = () => { if (!document.hidden) poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [poll, intervalMs]);
}

export default function ChatsPage() {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const sync = () => setSelected(selectedFromHash());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const pollList = useCallback(async () => {
    try {
      const [nextChats, nextStatus] = await Promise.all([getJson("/api/chats"), getJson("/api/status")]);
      setChats(nextChats);
      setStatus(nextStatus);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);
  usePolling(pollList, 4000);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!chats || !q) return chats ?? [];
    return chats.filter(chat => chatName(chat).toLowerCase().includes(q) || chat.body?.toLowerCase().includes(q));
  }, [chats, query]);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  }

  if (status && !status.connected && (status.pairingQr || chats?.length === 0)) return <Pairing status={status} />;

  const active = chats?.find(chat => chat.id === selected) ?? null;
  return <div className={`app${selected ? " has-chat" : ""}`}>
    <aside className="sidebar">
      <header className="sidebar-head">
        <h1>Chats</h1>
        <span className={`conn ${status?.connected ? "on" : "off"}`}>{status?.connected ? "Connected" : "Offline"}</span>
        <button className="link-button" onClick={signOut}>Sign out</button>
      </header>
      {(offline || (status && !status.connected)) && <div className="banner" role="status">
        {offline ? "Can't reach the server. Retrying…" : "WhatsApp is disconnected, so new messages won't appear yet."}
      </div>}
      <div className="search"><input type="search" aria-label="Search chats" placeholder="Search chats" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <nav className="chat-list" aria-label="Chats">
        {chats === null && !offline && <p className="list-note">Loading chats…</p>}
        {chats !== null && shown.length === 0 && <p className="list-note">{query ? "No chats match your search." : "No messages yet. New messages will appear here."}</p>}
        {shown.map(chat => {
          const name = chatName(chat);
          return <a key={chat.id} className={`chat-row${chat.id === selected ? " active" : ""}`} href={`#${encodeURIComponent(chat.id)}`} aria-current={chat.id === selected ? "true" : undefined}>
            <Avatar name={name} id={chat.id} isGroup={chat.isGroup} />
            <span className="chat-row-text">
              <span className="chat-row-top"><strong dir="auto">{name}</strong><time>{listTime(chat.lastMessageAt)}</time></span>
              <span className={`chat-row-preview${chat.deleted ? " deleted" : ""}`} dir="auto">{preview(chat)}</span>
            </span>
          </a>;
        })}
      </nav>
    </aside>
    <main className="conversation">
      {selected
        ? <Conversation key={selected} chatId={selected} chat={active} />
        : <div className="no-chat"><h2>Your WhatsApp chats</h2><p className="muted">Pick a chat to read it.</p></div>}
    </main>
  </div>;
}

function Conversation({ chatId, chat }: { chatId: string; chat: Chat | null }) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [failed, setFailed] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const heightBeforeOlder = useRef<number | null>(null);
  const loadedOlder = useRef(false);
  const url = `/api/messages?chat=${encodeURIComponent(chatId)}`;

  // The latest page is refetched so edits and deletions show up too. Older pages
  // already loaded are kept, with the fresh copies replacing theirs.
  const poll = useCallback(async () => {
    try {
      const page = await getJson(url);
      setMessages(current => {
        const merged = new Map((current ?? []).map(message => [message.id, message]));
        for (const message of page.messages as Message[]) merged.set(message.id, message);
        return [...merged.values()].sort((a, b) => a.sentAt - b.sentAt || Number(a.id) - Number(b.id));
      });
      if (!loadedOlder.current) setHasOlder(page.hasOlder);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [url]);
  usePolling(poll, 3000);

  async function loadOlder() {
    if (!messages?.length || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await getJson(`${url}&beforeId=${messages[0].id}`);
      heightBeforeOlder.current = scroller.current?.scrollHeight ?? null;
      loadedOlder.current = true;
      setHasOlder(page.hasOlder);
      setMessages(current => {
        const merged = new Map((current ?? []).map(message => [message.id, message]));
        for (const message of page.messages as Message[]) if (!merged.has(message.id)) merged.set(message.id, message);
        return [...merged.values()].sort((a, b) => a.sentAt - b.sentAt || Number(a.id) - Number(b.id));
      });
    } catch {
      setFailed(true);
    } finally {
      setLoadingOlder(false);
    }
  }

  // Follow new messages only for someone already at the bottom, so reading
  // further up isn't interrupted. Loading older ones must not move the view.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (heightBeforeOlder.current !== null) {
      element.scrollTop += element.scrollHeight - heightBeforeOlder.current;
      heightBeforeOlder.current = null;
    } else if (atBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages]);

  const name = chat ? chatName(chat) : phoneFrom(chatId) ?? "Chat";
  const isGroup = chat?.isGroup ?? chatId.endsWith("@g.us");
  return <>
    <header className="conversation-head">
      <a className="back" href="#" aria-label="Back to chats">←</a>
      <Avatar name={name} id={chatId} isGroup={isGroup} />
      <div className="conversation-title"><h2 dir="auto">{name}</h2><span>{isGroup ? "Group" : phoneFrom(chatId) ?? "Direct message"}</span></div>
    </header>
    <div className="messages" ref={scroller} onScroll={event => {
      const element = event.currentTarget;
      atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
    }}>
      {hasOlder && <button className="load-older" onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? "Loading…" : "Load older messages"}</button>}
      {messages === null && !failed && <p className="day"><span>Loading messages…</span></p>}
      {messages?.length === 0 && <p className="day"><span>No messages in this chat yet</span></p>}
      {failed && <p className="day"><span>Couldn't load messages. Retrying…</span></p>}
      {messages?.map((message, index) => {
        const previous = messages[index - 1];
        const newDay = !previous || dayLabel(previous.sentAt) !== dayLabel(message.sentAt);
        const sameSender = !newDay && previous.fromMe === message.fromMe && senderLabel(previous) === senderLabel(message);
        return <div key={message.id}>
          {newDay && <p className="day"><span>{dayLabel(message.sentAt)}</span></p>}
          <Bubble message={message} showName={!sameSender} />
        </div>;
      })}
    </div>
    <footer className="read-only">Read-only: this app can't send messages</footer>
  </>;
}

function Bubble({ message, showName }: { message: Message; showName: boolean }) {
  const label = senderLabel(message);
  const kindLabel = message.kind !== "text" ? kindLabels[message.kind] ?? kindLabels.other : null;
  const quotedName = message.quotedSenderName || phoneFrom(message.quotedSenderJid) || "Unknown";
  return <div className={`row ${message.fromMe ? "out" : "in"}${showName ? " first" : ""}`}>
    <div className="bubble">
      {showName && <div className="sender" dir="auto" style={message.fromMe ? undefined : { color: colorFor(message.senderJid ?? label) }}>{label}</div>}
      {message.deleted
        ? <p className="deleted">🚫 This message was deleted</p>
        : <>
          {message.quotedBody && <blockquote style={{ borderColor: colorFor(message.quotedSenderJid ?? "") }}>
            <strong style={{ color: colorFor(message.quotedSenderJid ?? "") }} dir="auto">{quotedName}</strong>
            <span dir="auto">{message.quotedBody}</span>
          </blockquote>}
          {kindLabel && <p className="media-label">{kindLabel}</p>}
          {message.body && <p dir="auto">{message.body}</p>}
        </>}
      <div className="meta">{message.edited && !message.deleted && "Edited · "}<time dateTime={new Date(message.sentAt * 1000).toISOString()}>{time(message.sentAt)}</time></div>
    </div>
  </div>;
}

// The bridge sends the QR as qrcode-terminal "small" text art, made for dark terminals:
// each character is one column and two rows, and a filled glyph means a LIGHT module.
// Redraw it as an SVG so it scales to fit the card with dark modules on white.
function PairingQr({ text }: { text: string }) {
  const lines = text.replace(/\n+$/, "").split("\n");
  const width = Math.max(...lines.map(line => [...line].length));
  const light: Record<string, [boolean, boolean]> = { "█": [true, true], "▀": [true, false], "▄": [false, true] };
  let path = "";
  lines.forEach((line, row) => {
    const cells = [...line];
    for (let col = 0; col < width; col++) {
      const [topLight, bottomLight] = light[cells[col] ?? "█"] ?? [false, false];
      if (!topLight) path += `M${col} ${row * 2}h1v1h-1z`;
      if (!bottomLight) path += `M${col} ${row * 2 + 1}h1v1h-1z`;
    }
  });
  return <svg viewBox={`0 0 ${width} ${lines.length * 2}`} shapeRendering="crispEdges" role="img" aria-label="WhatsApp pairing QR code">
    <rect width="100%" height="100%" fill="#fff" />
    <path d={path} fill="#000" />
  </svg>;
}

function Pairing({ status }: { status: Status }) {
  return <main className="center-page">
    <div className="auth-card">
      <h1>Connect WhatsApp</h1>
      <p className="muted">Scan with the WhatsApp account you want to read. This page moves on by itself once you're linked.</p>
      {status.pairingQr
        ? <div className="qr"><PairingQr text={status.pairingQr} /></div>
        : <div className="notice">{status.lastError || "Waiting for the WhatsApp connection to start…"}</div>}
      <ol className="how-to"><li>Open WhatsApp on your phone</li><li>Go to Settings → Linked devices</li><li>Tap Link a device and scan the code</li></ol>
    </div>
  </main>;
}
