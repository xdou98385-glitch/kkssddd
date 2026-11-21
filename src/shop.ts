// 购物算数：跨店满减、凑单还差多少、每件分摊后的实付。金额全部按「分」算，避免小数误差。
// 这里只做计算，不连任何购物平台，也不会下单或付款。
export interface Item { name?: string; price: number; qty?: number }
export interface Rule {
  kind: "every" | "tier"; // every = 每满 threshold 减 off；tier = 阶梯（满 a 减 x，满 b 减 y，取最高那档）
  threshold?: number;
  off?: number;
  tiers?: { threshold: number; off: number }[];
  cap?: number; // 最多减多少（有的活动封顶）
}

const cents = (yuan: number) => Math.round(yuan * 100);
const yuan = (c: number) => (c / 100).toFixed(2).replace(/\.00$/, "");

export function calc(items: Item[], rule: Rule | null, couponsOff: number[] = []): string {
  if (!Array.isArray(items) || !items.length) throw new Error("没有商品");
  const rows = items.map((it, i) => {
    const price = cents(Number(it.price)), qty = Math.max(1, Math.round(Number(it.qty ?? 1)));
    if (!Number.isFinite(price) || price < 0) throw new Error(`第 ${i + 1} 件的价格不对`);
    return { name: String(it.name || `商品${i + 1}`).slice(0, 30), price, qty, total: price * qty };
  });
  const gross = rows.reduce((s, r) => s + r.total, 0);
  const coupons = couponsOff.map((c) => cents(Number(c))).filter((c) => c > 0);
  const couponTotal = Math.min(coupons.reduce((s, c) => s + c, 0), gross);
  const base = gross - couponTotal; // 满减按「已用完店铺券/立减之后」的金额算（常见规则；平台不同可能有出入，要她核对）

  let off = 0;
  let gap = "";
  if (rule) {
    if (rule.kind === "every") {
      const t = cents(Number(rule.threshold)), o = cents(Number(rule.off));
      if (!(t > 0) || !(o > 0)) throw new Error("满减规则缺 threshold / off");
      off = Math.floor(base / t) * o;
      gap = `再买 ${yuan(t - (base % t))} 元可再减 ${yuan(o)} 元`;
    } else {
      const tiers = (rule.tiers ?? []).map((x) => ({ t: cents(x.threshold), o: cents(x.off) })).sort((a, b) => a.t - b.t);
      if (!tiers.length) throw new Error("阶梯满减缺 tiers");
      const hit = [...tiers].reverse().find((x) => base >= x.t);
      off = hit?.o ?? 0;
      const next = tiers.find((x) => x.t > base);
      gap = next ? `再买 ${yuan(next.t - base)} 元可升到「满 ${yuan(next.t)} 减 ${yuan(next.o)}」（多减 ${yuan(next.o - off)} 元）` : "已到最高一档";
    }
    if (rule.cap != null) off = Math.min(off, cents(Number(rule.cap)));
  }
  const final = base - off;
  // 每件分摊：按金额比例把优惠摊下去（退货时按这个算每件实际付了多少）
  const totalOff = couponTotal + off;
  let left = totalOff;
  const share = rows.map((r, i) => {
    const s = i === rows.length - 1 ? left : Math.round((totalOff * r.total) / gross);
    left -= s;
    return { ...r, paid: r.total - s };
  });
  return [
    `商品原价合计 ${yuan(gross)} 元（${rows.reduce((s, r) => s + r.qty, 0)} 件）`,
    couponTotal ? `店铺券 / 立减 -${yuan(couponTotal)} 元 → ${yuan(base)} 元` : "",
    rule ? `满减 -${yuan(off)} 元（按 ${yuan(base)} 元算）` : "",
    `应付 ${yuan(final)} 元，共省 ${yuan(totalOff)} 元（约 ${gross ? ((totalOff / gross) * 100).toFixed(1) : 0}% 折）`,
    gap ? `凑单：${gap}` : "",
    "每件分摊后实付：",
    ...share.map((r) => `- ${r.name} ×${r.qty}：${yuan(r.paid)} 元（原价 ${yuan(r.total)}）`),
    "（算法假设：先扣店铺券 / 立减，再按剩下的金额算满减。平台规则可能不同，以结算页为准。）",
  ].filter(Boolean).join("\n");
}
