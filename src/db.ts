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

function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
ensureColumn("messages", "images", "TEXT"); // JSON 数组：上传图片的文件名
ensureColumn("conversations", "summary", "TEXT NOT NULL DEFAULT ''"); // 更早对话的摘要
ensureColumn("conversations", "summarized_upto", "INTEGER NOT NULL DEFAULT 0"); // 摘要覆盖到的最后一条消息 id

export interface Conversation {
  id: string;
  title: string;
  model: string;
  created_at: number;
  updated_at: number;
  summary: string;
  summarized_upto: number;
}
export interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  images: string[];
  created_at: number;
}

interface MessageRow {
  id: number;
  role: "user" | "assistant";
  content: string;
  images: string | null;
  created_at: number;
}
const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  role: r.role,
  content: r.content,
  images: r.images ? JSON.parse(r.images) : [],
  created_at: r.created_at,
});

const now = () => Date.now();

export function getConversation(id: string): Conversation | undefined {
  return db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
    | Conversation
    | undefined;
}

export function createConversation(model: string): Conversation {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "Claude", model, now(), now());
  return getConversation(id)!;
}

/** 唯一的主对话：最近活跃的那条；一条都没有就建一条 */
export function mainConversation(defaultModel: string): Conversation {
  const c = db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 1").get() as
    | Conversation
    | undefined;
  return c ?? createConversation(defaultModel);
}

export function setModel(id: string, model: string): void {
  db.prepare("UPDATE conversations SET model = ? WHERE id = ?").run(model, id);
}

export function setSummary(id: string, summary: string, upto: number): void {
  db.prepare("UPDATE conversations SET summary = ?, summarized_upto = ? WHERE id = ?").run(
    summary,
    upto,
    id,
  );
}

/** 界面用：最近的 limit 条（可指定 before 往前翻页），按时间正序返回 */
export function messagePage(
  conversationId: string,
  before: number | null,
  limit: number,
): { messages: Message[]; hasMore: boolean } {
  const rows = db
    .prepare(
      `SELECT id, role, content, images, created_at FROM messages
       WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
    )
    .all(conversationId, before ?? Number.MAX_SAFE_INTEGER, limit + 1) as unknown as MessageRow[];
  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit).reverse().map(toMessage), hasMore };
}

/** 发给模型用：摘要之后的所有消息 */
export function windowMessages(conversationId: string, afterId: number): Message[] {
  return (
    db
      .prepare(
        `SELECT id, role, content, images, created_at FROM messages
         WHERE conversation_id = ? AND id > ? ORDER BY id`,
      )
      .all(conversationId, afterId) as unknown as MessageRow[]
  ).map(toMessage);
}

export function addMessage(
  conversationId: string,
  role: Message["role"],
  content: string,
  images: string[] = [],
): void {
  db.prepare(
    "INSERT INTO messages (conversation_id, role, content, images, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(conversationId, role, content, images.length ? JSON.stringify(images) : null, now());
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
