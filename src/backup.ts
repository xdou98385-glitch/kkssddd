// 自动备份：每天用 SQLite 的 VACUUM INTO 拷一份一致的快照到数据库旁边的 backups/，留最近 7 份。
// 注意：备份和数据库在同一块盘上，防的是「手滑清空 / 配置写错 / 数据库损坏」，不防服务器整个没了。
// 所以设置页「其他」里有「下载最新备份」，隔一阵下载一份放到自己电脑上。备份里包含所有密钥，别发给别人。
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as db from "./db.ts";

const dbPath = process.env.DB_PATH ?? "data/chat.db";
const dir = join(dirname(dbPath), "backups");
const KEEP = 7;
const NAME = /^chat-\d{4}-\d{2}-\d{2}(-\d{4})?\.db$/;

export function listBackups(): { name: string; size: number; at: number }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => NAME.test(n))
    .map((n) => { const s = statSync(join(dir, n)); return { name: n, size: s.size, at: s.mtimeMs }; })
    .sort((a, b) => b.at - a.at);
}
export const latestBackupPath = (): string | null => { const l = listBackups()[0]; return l ? join(dir, l.name) : null; };
export const backupFileName = (p: string) => basename(p);

export function runBackup(manual = false): string {
  mkdirSync(dir, { recursive: true });
  const d = new Date();
  const day = d.toISOString().slice(0, 10);
  const name = manual ? `chat-${day}-${d.toISOString().slice(11, 16).replace(":", "")}.db` : `chat-${day}.db`;
  const file = join(dir, name);
  if (existsSync(file)) unlinkSync(file); // VACUUM INTO 不能覆盖已有文件
  db.backupTo(file);
  for (const old of listBackups().slice(KEEP)) unlinkSync(join(dir, old.name));
  return name;
}

/** 启动时补一次，之后每 6 小时看一眼今天有没有备份过 */
export function startBackups(): void {
  const check = () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (!listBackups().some((b) => b.name.startsWith(`chat-${today}`))) console.log("backup:", runBackup());
    } catch (err) {
      console.error("backup:", err instanceof Error ? err.message : err);
    }
  };
  check();
  setInterval(check, 6 * 3600_000).unref();
}
