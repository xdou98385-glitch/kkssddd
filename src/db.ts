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
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    app TEXT,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
`);
ensureColumn("messages", "kind", "TEXT"); // 'proactive' = Claude 主动发的
ensureColumn("messages", "tools", "TEXT"); // JSON 数组：这条回复真正调用过的工具名（系统记录，不是模型自己说的）
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
  tools: string[];
  kind: string | null; // 'proactive' = 主动消息
  created_at: number;
}

interface MessageRow {
  id: number;
  role: "user" | "assistant";
  content: string;
  images: string | null;
  tools: string | null;
  kind: string | null;
  created_at: number;
}
const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  role: r.role,
  content: r.content,
  images: r.images ? JSON.parse(r.images) : [],
  tools: r.tools ? JSON.parse(r.tools) : [],
  kind: r.kind,
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
      `SELECT id, role, content, images, tools, kind, created_at FROM messages
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
        `SELECT id, role, content, images, tools, kind, created_at FROM messages
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
  kind: "proactive" | null = null,
  tools: string[] = [],
): number {
  const r = db.prepare(
    "INSERT INTO messages (conversation_id, role, content, images, kind, tools, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    conversationId,
    role,
    content,
    images.length ? JSON.stringify(images) : null,
    kind,
    tools.length ? JSON.stringify(tools) : null,
    now(),
  );
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), conversationId);
  return Number(r.lastInsertRowid);
}

/** 一条助手消息的正文（给语音用） */
export function assistantText(id: number): string | null {
  const r = db.prepare("SELECT content FROM messages WHERE id = ? AND role = 'assistant'").get(id) as { content: string } | undefined;
  return r?.content ?? null;
}

/** 最后一条消息（含是否是主动发的），用来判断要不要再主动开口 */
export function lastMessage(
  conversationId: string,
): { role: "user" | "assistant"; kind: string | null; created_at: number } | undefined {
  return db
    .prepare("SELECT role, kind, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1")
    .get(conversationId) as { role: "user" | "assistant"; kind: string | null; created_at: number } | undefined;
}

/** 可以重新生成的末尾回复：最后一条是她正常对话里的助手回复，且前一条是她说的话。返回它的 id */
export function regenerableTail(conversationId: string): number | null {
  const rows = db
    .prepare("SELECT id, role, kind FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 2")
    .all(conversationId) as { id: number; role: string; kind: string | null }[];
  const [last, prev] = rows;
  return last && prev && last.role === "assistant" && last.kind === null && prev.role === "user" ? last.id : null;
}

interface RawMessage {
  conversation_id: string;
  role: string;
  content: string;
  images: string | null;
  kind: string | null;
  tools: string | null;
  created_at: number;
}

/** 删掉一条消息并返回原样，重新生成失败时用 restoreMessage 放回去 */
export function takeMessage(id: number): RawMessage | undefined {
  const row = db
    .prepare("SELECT conversation_id, role, content, images, kind, tools, created_at FROM messages WHERE id = ?")
    .get(id) as RawMessage | undefined;
  if (row) db.prepare("DELETE FROM messages WHERE id = ?").run(id);
  return row;
}

export function restoreMessage(m: RawMessage): void {
  db.prepare(
    "INSERT INTO messages (conversation_id, role, content, images, kind, tools, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(m.conversation_id, m.role, m.content, m.images, m.kind, m.tools, m.created_at);
}

export function proactiveStats(conversationId: string, since: number): { count: number; lastAt: number } {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(created_at), 0) AS last FROM messages
       WHERE conversation_id = ? AND kind = 'proactive' AND created_at >= ?`,
    )
    .get(conversationId, since) as { n: number; last: number };
  return { count: r.n, lastAt: r.last };
}

// ---- 推送订阅 ----
export function savePushSub(sub: { endpoint: string }): void {
  db.prepare(
    "INSERT INTO push_subs (endpoint, sub, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET sub = excluded.sub",
  ).run(sub.endpoint, JSON.stringify(sub), now());
}
export function listPushSubs(): any[] {
  return (db.prepare("SELECT sub FROM push_subs").all() as unknown as { sub: string }[]).map((r) => JSON.parse(r.sub));
}
export function removePushSub(endpoint: string): void {
  db.prepare("DELETE FROM push_subs WHERE endpoint = ?").run(endpoint);
}

// ---- 设备事件（iPhone 快捷指令等上报） ----
export interface DeviceEvent {
  id: number;
  at: number;
  kind: string;
  app: string | null;
  detail: string | null;
}
export function addEvent(kind: string, app: string | null, detail: string | null, at = now()): void {
  db.prepare("INSERT INTO events (at, kind, app, detail) VALUES (?, ?, ?, ?)").run(at, kind, app, detail);
  db.prepare("DELETE FROM events WHERE at < ?").run(now() - 30 * 86400_000); // 只留 30 天
}
export function eventsSince(since: number, limit = 200): DeviceEvent[] {
  return (
    db.prepare("SELECT id, at, kind, app, detail FROM events WHERE at >= ? ORDER BY at DESC LIMIT ?").all(since, limit) as unknown as DeviceEvent[]
  ).reverse();
}
export function latestEvent(): DeviceEvent | undefined {
  return db.prepare("SELECT id, at, kind, app, detail FROM events ORDER BY at DESC LIMIT 1").get() as DeviceEvent | undefined;
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
