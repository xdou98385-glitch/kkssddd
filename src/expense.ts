// 记账：一句话记、发小票记、Apple Pay 交易自动收，晚上问一句有没有漏。只记账，不连任何银行或平台。
// 金额按「最小单位」存整数（日元没有小数，其他币种按分），不同币种分开统计，不换算。
import * as db from "./db.ts";
import { userTz } from "./device.ts";

export const CATS = ["餐饮", "交通", "购物", "日用", "房租水电", "学习", "娱乐", "医疗", "通讯", "订阅", "社交", "其他"];
const tz = () => (userTz() === "UTC" ? "Asia/Tokyo" : userTz());
const exp = (cur: string) => (cur === "JPY" || cur === "KRW" ? 0 : 2);
const toMinor = (amount: number, cur: string) => Math.round(Number(amount) * 10 ** exp(cur));
export const fmtMoney = (minor: number, cur: string) => {
  const e = exp(cur);
  const v = minor / 10 ** e;
  return `${cur === "JPY" ? "¥" : cur === "CNY" ? "RMB " : cur === "USD" ? "$" : cur + " "}${e ? v.toFixed(2).replace(/\.00$/, "") : String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
};
const normCat = (c: string) => (CATS.includes(c) ? c : c ? "其他" : "");

// ---- 本地日期工具（按她的时区）----
function parts(ms: number) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(ms);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return { y: g("year"), mo: g("month"), d: g("day"), h: g("hour") % 24, mi: g("minute") };
}
export const localDayStart = (ms: number) => { const p = parts(ms); return ms - (p.h * 60 + p.mi) * 60_000 - (ms % 60_000); };
const dayKey = (ms: number) => { const p = parts(ms); return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; };
const monthStart = (ms: number) => { const p = parts(ms); return localDayStart(ms) - (p.d - 1) * 86400_000; };
const daysInMonth = (ms: number) => { const p = parts(ms); return new Date(Date.UTC(p.y, p.mo, 0)).getUTCDate(); };

export function expenseAdd(a: { amount: number; currency: string; category: string; merchant: string; note: string; days_ago: number }, source = "chat"): string {
  const cur = String(a.currency || "JPY").toUpperCase().slice(0, 4);
  const amount = Number(a.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw new Error("金额要是大于 0 的数字");
  const ago = Math.max(0, Math.min(Math.round(Number(a.days_ago) || 0), 365));
  const at = Date.now() - ago * 86400_000;
  const id = db.addExpense({ at, amount_minor: toMinor(amount, cur), currency: cur, category: normCat(String(a.category ?? "")), merchant: String(a.merchant ?? "").trim().slice(0, 40), note: String(a.note ?? "").trim().slice(0, 80), source });
  const e = db.getExpense(id)!;
  return `已记 #${id}：${fmtMoney(e.amount_minor, cur)} ${e.category || "未分类"}${e.merchant ? " " + e.merchant : ""}${e.note ? "（" + e.note + "）" : ""}${ago ? `，${ago} 天前` : ""}`;
}

export function expenseUpdate(a: { id: number; amount: number; category: string; merchant: string; note: string }): string {
  const e = db.getExpense(Number(a.id));
  if (!e) throw new Error(`没有 #${a.id}`);
  const p: Parameters<typeof db.updateExpense>[1] = {};
  if (Number(a.amount) > 0) p.amount_minor = toMinor(a.amount, e.currency);
  if (a.category) p.category = normCat(a.category);
  if (a.merchant) p.merchant = String(a.merchant).trim().slice(0, 40);
  if (a.note) p.note = String(a.note).trim().slice(0, 80);
  if (!Object.keys(p).length) throw new Error("没有要改的内容");
  db.updateExpense(e.id, p);
  return `已更新 #${e.id}`;
}
export const expenseDelete = (id: number) => { if (!db.deleteExpense(Number(id))) throw new Error(`没有 #${id}`); return `已删除 #${id}`; };

const budgets = (): Record<string, number> => { try { return JSON.parse(db.getSetting("expense_budget") || "{}"); } catch { return {}; } };
export function budgetSet(amount: number, currency: string): string {
  const cur = String(currency || "JPY").toUpperCase();
  const b = budgets();
  if (Number(amount) > 0) b[cur] = toMinor(amount, cur); else delete b[cur];
  db.setSetting("expense_budget", JSON.stringify(b));
  return Number(amount) > 0 ? `${cur} 月预算已设为 ${fmtMoney(b[cur], cur)}` : `${cur} 月预算已清除`;
}

export function expenseList(days: number): string {
  const d = Math.max(1, Math.min(Math.round(days) || 7, 60));
  const rows = db.expensesBetween(Date.now() - d * 86400_000, Date.now() + 1);
  if (!rows.length) return `最近 ${d} 天没有记录`;
  const f = new Intl.DateTimeFormat("zh-CN", { timeZone: tz(), month: "numeric", day: "numeric" });
  return rows.slice(-60).map((e) => `- #${e.id} ${f.format(e.at)} ${fmtMoney(e.amount_minor, e.currency)} ${e.category || "未分类"}${e.merchant ? " " + e.merchant : ""}${e.note ? "（" + e.note + "）" : ""}${e.source === "wallet" ? " [Apple Pay]" : ""}`).join("\n");
}

export function expenseSummary(period: string): string {
  const now = Date.now();
  const from = period === "today" ? localDayStart(now) : period === "week" ? localDayStart(now) - 6 * 86400_000 : monthStart(now);
  const label = period === "today" ? "今天" : period === "week" ? "最近 7 天" : "本月";
  const rows = db.expensesBetween(from, now + 1);
  if (!rows.length) return `${label}还没有记录`;
  const out: string[] = [];
  for (const cur of [...new Set(rows.map((r) => r.currency))]) {
    const rs = rows.filter((r) => r.currency === cur);
    const total = rs.reduce((s, r) => s + r.amount_minor, 0);
    const byCat = new Map<string, { sum: number; n: number }>();
    for (const r of rs) { const k = r.category || "未分类"; const c = byCat.get(k) ?? { sum: 0, n: 0 }; c.sum += r.amount_minor; c.n++; byCat.set(k, c); }
    out.push(`${label}（${cur}）共 ${fmtMoney(total, cur)}，${rs.length} 笔`);
    out.push(...[...byCat].sort((a, b) => b[1].sum - a[1].sum).map(([k, v]) => `- ${k}：${fmtMoney(v.sum, cur)}（${Math.round((v.sum / total) * 100)}%，${v.n} 笔）`));
    const top = [...rs].sort((a, b) => b.amount_minor - a.amount_minor).slice(0, 3);
    out.push(`最大的几笔：${top.map((r) => `${fmtMoney(r.amount_minor, cur)} ${r.merchant || r.category || r.note || ""}`).join("；")}`);
    const budget = budgets()[cur];
    if (budget && period === "month") {
      const p = parts(now);
      const avg = total / p.d;
      const projected = Math.round(avg * daysInMonth(now));
      out.push(`月预算 ${fmtMoney(budget, cur)}：已用 ${Math.round((total / budget) * 100)}%，剩 ${fmtMoney(Math.max(0, budget - total), cur)}（本月还剩 ${daysInMonth(now) - p.d} 天）；按目前每天约 ${fmtMoney(Math.round(avg), cur)} 的速度，月底大约 ${fmtMoney(projected, cur)}${projected > budget ? "，会超" : "，不会超"}`);
    }
    const unc = rs.filter((r) => !r.category).length;
    if (unc) out.push(`（有 ${unc} 笔还没分类）`);
  }
  return out.join("\n");
}

/** Apple Pay「交易」自动化传来的：金额文字可能是 ¥1,280 / 480円 / $12.50 / 12.50 USD，商家名原样 */
export function walletAdd(amountText: string, merchant: string, note: string): string {
  const t = String(amountText ?? "").replace(/,/g, "").trim();
  const m = t.match(/-?\d+(?:\.\d+)?/);
  if (!m) throw new Error("没认出金额");
  const num = Math.abs(Number(m[0]));
  const cur = /rmb|cny|元|人民币|¥\s*\d.*cn/i.test(t) ? "CNY" : /\$|usd|ドル/i.test(t) ? "USD" : /eur|€/i.test(t) ? "EUR" : "JPY";
  return expenseAdd({ amount: num, currency: cur, category: "", merchant: String(merchant ?? ""), note: String(note ?? ""), days_ago: 0 }, "wallet");
}

// ---- 每晚问一句 ----
export interface Nudge { enabled: boolean; time: string }
export const getNudge = (): Nudge => { try { return { enabled: false, time: "21:30", ...JSON.parse(db.getSetting("expense_nudge") || "{}") }; } catch { return { enabled: false, time: "21:30" }; } };
export function nudgeSet(enabled: boolean, time: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("时间要写成 HH:MM，例如 21:30");
  db.setSetting("expense_nudge", JSON.stringify({ enabled: !!enabled, time }));
  return enabled ? `每晚 ${time} 会问你今天有没有花钱没记（今天已经记过就不打扰）` : "已关闭每晚记账提醒";
}
/** 今天的记账情况：手动记了几笔、Apple Pay 自动收了几笔还没分类 */
export function todayState(now = Date.now()) {
  const rows = db.expensesBetween(localDayStart(now), now + 1);
  return { manual: rows.filter((r) => r.source !== "wallet").length, walletUncategorized: rows.filter((r) => r.source === "wallet" && !r.category) };
}
export const localClock = (now = Date.now()) => { const p = parts(now); return { today: dayKey(now), minutes: p.h * 60 + p.mi, month: p.mo, day: p.d, year: p.y }; };
