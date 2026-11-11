// 重要日期簿：在留卡到期、学费缴纳、DDL、生日……说一次，提前几天提醒，可以每年重复。到点提醒由 scheduler.ts 每天上午跑一次。
import * as db from "./db.ts";
import { localClock } from "./expense.ts";

export function dateAdd(a: { title: string; date: string; repeat: string; remind_days: number[]; note: string }): string {
  const title = String(a.title ?? "").trim().slice(0, 60);
  if (!title) throw new Error("没写是什么日子");
  const m = String(a.date ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error("日期要写成 YYYY-MM-DD；每年重复的（比如生日）年份随便写今年的");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const chk = new Date(Date.UTC(y, mo - 1, d));
  if (chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) throw new Error("这个日期不存在");
  if (db.listImportantDates().length >= 60) throw new Error("已经有 60 条了，先删一些");
  const days = [...new Set((a.remind_days ?? []).map((n) => Math.round(Number(n))).filter((n) => n >= 0 && n <= 90))].sort((x, y2) => y2 - x);
  const yearly = a.repeat === "yearly";
  const id = db.addImportantDate({ title, month: mo, day: d, year: yearly ? 0 : y, repeat: yearly ? "yearly" : "once", remind_days: (days.length ? days : [7, 1]).join(","), note: String(a.note ?? "").trim().slice(0, 100) });
  return `已记 #${id}：${yearly ? `每年 ${mo} 月 ${d} 日` : `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`} ${title}，提前 ${(days.length ? days : [7, 1]).join("、")} 天提醒（0 表示当天）`;
}

/** 距离下一次发生还有几天（一次性的过了就是 null） */
function daysUntil(d: db.ImportantDate, today: { year: number; month: number; day: number }): { days: number; on: string } | null {
  const t0 = Date.UTC(today.year, today.month - 1, today.day);
  let y = d.repeat === "yearly" ? today.year : d.year;
  let target = Date.UTC(y, d.month - 1, d.day);
  if (d.repeat === "yearly" && target < t0) target = Date.UTC(++y, d.month - 1, d.day);
  if (target < t0) return null;
  return { days: Math.round((target - t0) / 86400_000), on: `${y}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` };
}

export function dateList(): string {
  const t = localClock();
  const ds = db.listImportantDates().map((d) => ({ d, u: daysUntil(d, { year: t.year, month: t.month, day: t.day }) })).filter((x) => x.u);
  if (!ds.length) return "日期簿是空的（或者一次性的日子都过了）";
  return ds.sort((a, b) => a.u!.days - b.u!.days).map(({ d, u }) => `- #${d.id} ${u!.on}（${u!.days === 0 ? "就是今天" : `还有 ${u!.days} 天`}）${d.repeat === "yearly" ? "【每年】" : ""}${d.title}｜提前 ${d.remind_days} 天提醒${d.note ? "｜" + d.note : ""}`).join("\n");
}
export const dateRemove = (id: number) => { if (!db.deleteImportantDate(Number(id))) throw new Error(`没有 #${id}`); return `已删除 #${id}`; };

/** 今天该提醒哪些（带去重键：同一次发生、同一个提前天数只提醒一次） */
export function dueToday(): { key: string; text: string }[] {
  const t = localClock();
  const out: { key: string; text: string }[] = [];
  for (const d of db.listImportantDates()) {
    const u = daysUntil(d, { year: t.year, month: t.month, day: t.day });
    if (!u) continue;
    for (const n of d.remind_days.split(",").map(Number)) {
      if (n === u.days) out.push({ key: `${d.id}:${u.on}:${n}`, text: `${u.days === 0 ? "今天" : `还有 ${u.days} 天（${u.on}）`}：${d.title}${d.note ? "（" + d.note + "）" : ""}` });
    }
  }
  return out;
}
