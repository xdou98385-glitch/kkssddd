// 购物清单：记住她想买什么、多少钱、优先级，关掉聊天再回来还在。金额按「分」存、按「元」显示。
// 只是记账，不连任何平台。
import * as db from "./db.ts";

const cents = (yuan: unknown) => { const n = Math.round(Number(yuan) * 100); return Number.isFinite(n) && n >= 0 ? n : 0; };
const yuan = (c: number) => (c / 100).toFixed(2).replace(/\.00$/, "");
const PRI = ["", "必买", "想买", "可买可不买"];

export function wishAdd(a: { name: string; spec: string; target_price: number; price: number; link: string; priority: number; note: string }): string {
  const name = String(a.name ?? "").trim().slice(0, 60);
  if (!name) throw new Error("没写商品名");
  if (db.countWishes() >= 100) throw new Error("清单已经 100 条了，先清理一些");
  const priority = [1, 2, 3].includes(Number(a.priority)) ? Number(a.priority) : 2;
  const id = db.addWish({ name, spec: String(a.spec ?? "").trim().slice(0, 60), target_cents: cents(a.target_price), price_cents: cents(a.price), link: String(a.link ?? "").trim().slice(0, 300), priority, note: String(a.note ?? "").trim().slice(0, 120) });
  return `已加入清单 #${id}：${name}${a.spec ? `（${a.spec}）` : ""}，${PRI[priority]}${cents(a.price) ? `，现价 ${yuan(cents(a.price))} 元` : ""}${cents(a.target_price) ? `，目标价 ${yuan(cents(a.target_price))} 元` : ""}`;
}

export function wishUpdate(a: { id: number; price: number; target_price: number; priority: number; status: string; note: string }): string {
  const w = db.getWish(Number(a.id));
  if (!w) throw new Error(`没有 #${a.id}`);
  const patch: Parameters<typeof db.updateWish>[1] = {};
  if (Number(a.price) > 0) patch.price_cents = cents(a.price);
  if (Number(a.target_price) > 0) patch.target_cents = cents(a.target_price);
  if ([1, 2, 3].includes(Number(a.priority))) patch.priority = Number(a.priority);
  if (["want", "bought", "dropped"].includes(a.status)) patch.status = a.status;
  if (a.note && a.note.trim()) patch.note = a.note.trim().slice(0, 120);
  db.updateWish(w.id, patch);
  return `已更新 #${w.id} ${w.name}${patch.status === "bought" ? "（标记为已买）" : patch.status === "dropped" ? "（已从清单划掉）" : ""}`;
}

export function setBudget(yuanAmount: number): string {
  const c = cents(yuanAmount);
  db.setSetting("wish_budget", String(c));
  return c ? `预算已记下：${yuan(c)} 元` : "预算已清除";
}

export function wishList(): string {
  const items = db.listWishes();
  const budget = Number(db.getSetting("wish_budget", "0")) || 0;
  if (!items.length) return `清单是空的${budget ? `（预算 ${yuan(budget)} 元）` : ""}`;
  const price = (w: db.Wish) => w.price_cents || w.target_cents; // 有现价按现价，没有按目标价估
  const line = (w: db.Wish) => `- #${w.id} ${w.status === "bought" ? "【已买】" : ""}${w.name}${w.spec ? `（${w.spec}）` : ""} | ${w.price_cents ? `现价 ${yuan(w.price_cents)}` : "没记现价"}${w.target_cents ? ` | 目标 ${yuan(w.target_cents)}${w.price_cents && w.price_cents <= w.target_cents ? " ✓已到目标价" : ""}` : ""}${w.note ? ` | ${w.note}` : ""}${w.link ? ` | ${w.link}` : ""}`;
  const out: string[] = [];
  let want = 0, bought = 0, unpriced = 0;
  for (const p of [1, 2, 3]) {
    const g = items.filter((w) => w.priority === p);
    if (!g.length) continue;
    out.push(`【${PRI[p]}】`, ...g.map(line));
  }
  for (const w of items) {
    if (w.status === "bought") bought += price(w);
    else { want += price(w); if (!price(w)) unpriced++; }
  }
  const mustLeft = items.filter((w) => w.priority === 1 && w.status !== "bought").reduce((s, w) => s + price(w), 0);
  out.push("", `还没买的合计 ${yuan(want)} 元${unpriced ? `（有 ${unpriced} 件没记价格，没算进去）` : ""}；已买 ${yuan(bought)} 元；必买里还剩 ${yuan(mustLeft)} 元。`);
  if (budget) out.push(`预算 ${yuan(budget)} 元：全买完${want + bought > budget ? `超出 ${yuan(want + bought - budget)} 元` : `还剩 ${yuan(budget - want - bought)} 元`}；只买必买${bought + mustLeft > budget ? `也超出 ${yuan(bought + mustLeft - budget)} 元` : `还剩 ${yuan(budget - bought - mustLeft)} 元`}。`);
  out.push("（只是按清单上的价格加总，没算满减券，要算优惠用 shop_calc。价格是她记的或截图当时的，会变。）");
  return out.join("\n");
}
