import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const path = process.env.DB_PATH ?? "data/chat.db";
mkdirSync(dirname(path), { recursive: true });

const db = new DatabaseSync(path);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

export interface Conversation {
  id: string;
  title: string;
  model: string;
  created_at: number;
  updated_at: number;
}
export interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
}

const now = () => Date.now();

export function listConversations(): Conversation[] {
  return db
    .prepare("SELECT * FROM conversations ORDER BY updated_at DESC")
    .all() as unknown as Conversation[];
}

export function getConversation(id: string): Conversation | undefined {
  return db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
    | Conversation
    | undefined;
}

export function createConversation(model: string): Conversation {
  const c: Conversation = {
    id: randomUUID(),
    title: "新对话",
    model,
    created_at: now(),
    updated_at: now(),
  };
  db.prepare(
    "INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(c.id, c.title, c.model, c.created_at, c.updated_at);
  return c;
}

export function updateConversation(
  id: string,
  patch: { title?: string; model?: string },
): void {
  if (patch.title !== undefined)
    db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(patch.title, id);
  if (patch.model !== undefined)
    db.prepare("UPDATE conversations SET model = ? WHERE id = ?").run(patch.model, id);
}

export function deleteConversation(id: string): void {
  db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
}

export function listMessages(conversationId: string): Message[] {
  return db
    .prepare("SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY id")
    .all(conversationId) as unknown as Message[];
}

export function addMessage(
  conversationId: string,
  role: Message["role"],
  content: string,
): void {
  db.prepare(
    "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
  ).run(conversationId, role, content, now());
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), conversationId);
}

export function getSetting(key: string, fallback = ""): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
