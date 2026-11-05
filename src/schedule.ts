// 提醒 + Claude 给自己约时间找她。这里只放「记下来、列出来、取消」，到点发消息在 scheduler.ts。
import * as db from "./db.ts";
import { userTz } from "./device.ts";

const MAX_PENDING = 20;
const MAX_AHEAD_MS = 60 * 86400_000;

function parts(ms: number, tz: string) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(ms);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return { y: g("year"), mo: g("month"), d: g("day"), h: g("hour") % 24, mi: g("minute") };
}
/** 「她当地的 YYYY-MM-DD HH:MM」→ 毫秒时间戳；格式不对或不是真实存在的时刻返回 null */
export function zonedToMs(str: string, tz: string): number | null {
  const m = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (ms: number) => { const p = parts(ms, tz); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(ms / 60000) * 60000; };
  let t = guess - offset(guess);
  t = guess - offset(t);
  const back = parts(t, tz);
  return back.y === y && back.mo === mo && back.d === d && back.h === h && back.mi === mi ? t : null;
}
export const fmtLocal = (ms: number, tz = userTz()) =>
  new Intl.DateTimeFormat("zh-CN", { timeZone: tz, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);

export function schedule(kind: "reminder" | "checkin", when: string, text: string): string {
  const tz = userTz() === "UTC" ? "Asia/Tokyo" : userTz();
  const at = zonedToMs(String(when), tz);
  if (at === null) throw new Error("时间格式要写成她当地时间的 YYYY-MM-DD HH:MM，例如 2026-11-04 09:00");
  if (at < Date.now() + 60_000) throw new Error("这个时间已经过了，或者不到 1 分钟后。先对照她最新那条消息开头的时间再算一次");
  if (at > Date.now() + MAX_AHEAD_MS) throw new Error("最多只能约 60 天以内的时间");
  const t = String(text ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
  if (!t) throw new Error("内容是空的");
  if (db.listScheduled().length >= MAX_PENDING) throw new Error(`待办已经有 ${MAX_PENDING} 条了，先取消一些再加`);
  const id = db.addScheduled(kind, at, t);
  return `已记下 #${id}：${fmtLocal(at, tz)}（${tz}）${kind === "reminder" ? "提醒她" : "主动找她"}：${t}`;
}

export function listScheduledText(): string {
  const tz = userTz() === "UTC" ? "Asia/Tokyo" : userTz();
  const items = db.listScheduled();
  return items.length ? "待发的：\n" + items.map((i) => `- #${i.id} ${fmtLocal(i.due_at, tz)} ${i.kind === "reminder" ? "提醒" : "主动找她"}：${i.text}`).join("\n") : "现在没有待发的提醒或约好的时间";
}

export function cancelScheduled(id: number): string {
  const it = db.getScheduled(id);
  if (!it || it.status !== "pending") throw new Error(`没有 #${id} 这条待发的`);
  db.setScheduledStatus(id, "cancelled");
  return `已取消 #${id}：${it.text}`;
}
