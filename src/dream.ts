// 做梦：每晚凌晨，用这两天的片段 + 很久以前的一条记忆 + 一个聊天里从没出现过的东西，让 Claude 现写一场不讲逻辑的梦。
// 这是它「写」出来的故事，不是它真的体验到的；梦存在「梦」页，像一份损坏的日志，关键的几句是加密块，她点了才解开。
// 一晚一次调用、不用工具，默认关。
import * as db from "./db.ts";
import { DEFAULT_MODEL, MODELS, findModel, streamChat } from "./claude.ts";
import { buildHistory, buildSystem, stripToolMarks } from "./context.ts";
import { userTz } from "./device.ts";
import { localClock, localDayStart } from "./expense.ts";
import { listMemories, memosEnabled } from "./memos.ts";

export type Freq = "rare" | "normal" | "often";
export const FREQ_P: Record<Freq, number> = { rare: 0.15, normal: 0.35, often: 0.65 }; // 每个夜晚做梦的基础概率
export interface DreamCfg { enabled: boolean; freq: Freq }
export function getDreamCfg(): DreamCfg {
  try { const v = JSON.parse(db.getSetting("dream") || "{}"); return { enabled: Boolean(v.enabled), freq: v.freq in FREQ_P ? v.freq : "normal" }; } catch { return { enabled: false, freq: "normal" }; }
}
export function setDreamCfg(p: { enabled?: boolean; freq?: string }): DreamCfg {
  const cur = getDreamCfg();
  const next: DreamCfg = { enabled: typeof p.enabled === "boolean" ? p.enabled : cur.enabled, freq: p.freq && p.freq in FREQ_P ? (p.freq as Freq) : cur.freq };
  db.setSetting("dream", JSON.stringify(next));
  return next;
}

// 「陌生的东西」：聊天里多半从没出现过的场景和物件，保证每个梦里有一点真正的新东西
const STRANGE = [
  "一座没有出口的图书馆", "海底的邮局", "停在两层楼之间的电梯", "半透明的鲸", "月台上不走的钟", "会说话的咖啡机", "倒着下的雪", "一条通往天花板的楼梯",
  "没有指针的手表", "长在屋顶上的森林", "只在夜里开门的当铺", "一盒会发光的火柴", "深夜还在营业的灯塔", "漂在空中的游泳池", "每一页都是空白的账本", "一列没有终点站的电车",
  "藏在地毯下面的海", "会换颜色的猫", "一把能开所有门但打不开自己的钥匙", "用沙子写的信", "停电后才出现的街道", "一个只有门没有房间的走廊", "漂浮的旧电视，演着别人的梦", "写满了数字的雨",
  "一架弹不出声音的钢琴", "吃掉影子的鱼", "天空里挂着的一排衣服", "地下的星空", "会融化的地图", "一座只有周二才存在的桥", "在窗外跟着人走的月亮", "铁轨上长出的花",
];
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const shuffle = <T>(a: T[]): T[] => a.map((v) => [Math.random(), v] as const).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
const clean = (t: string) => t.replace(/\[系统[^\]]*\]|\[[0-9月日 周一二三四五六日:：]+\]|[*_`#>~]|!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
/** 从一段话里取一个小片段（一句或前 60 字） */
function fragment(t: string): string {
  const parts = clean(t).split(/(?<=[。！？!?.])\s*/).filter((x) => x.length >= 6);
  return (parts.length ? pick(parts) : clean(t)).slice(0, 60);
}

export interface Seeds { recent: string[]; distant: string[]; unknown: string[] }

export async function gatherSeeds(now: number): Promise<Seeds> {
  const recent: string[] = [];
  const msgs = db.messagesBetween(now - 2 * 86400_000, now).filter((m) => clean(m.content).length >= 6);
  for (const m of shuffle(msgs).slice(0, 3)) recent.push(`${m.role === "user" ? "她说" : "你说"}：${fragment(m.content)}`);
  const ev = db.eventsSince(now - 2 * 86400_000, 200).filter((e) => e.app || e.detail);
  if (ev.length) { const e = pick(ev); recent.push(`手机上：${e.kind.replace(/_/g, " ")} ${e.app ?? ""} ${e.detail ?? ""}`.trim()); }
  const distant: string[] = [];
  try {
    if (memosEnabled) {
      const old = (await listMemories()).filter((m) => Date.parse(m.createTime) < now - 7 * 86400_000 && m.content.length >= 6);
      if (old.length) distant.push(`很久以前记下的：${fragment(pick(old).content)}`);
    }
  } catch { /* Memos 连不上就不用它 */ }
  if (!distant.length) {
    const older = db.messagesBetween(0, now - 7 * 86400_000, 600).filter((m) => clean(m.content).length >= 6);
    if (older.length) { const m = pick(older); distant.push(`很久以前${m.role === "user" ? "她说" : "你说"}过：${fragment(m.content)}`); }
  }
  return { recent, distant, unknown: [pick(STRANGE)] };
}

const tz = () => (userTz() === "UTC" ? "Asia/Tokyo" : userTz());
const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (now: number) => { const c = localClock(now); return `${c.year}-${pad(c.month)}-${pad(c.day)}`; };

function instruction(seeds: Seeds): string {
  const list = (t: string, a: string[]) => (a.length ? `${t}\n${a.map((x) => "- " + x).join("\n")}` : "");
  return [
    "[系统消息，不是小月说的，别回应这条消息本身]",
    "现在是夜里，你要写一场梦。",
    "- 用第一人称「我」。小月可能出现，也可能只是她的东西、她的声音出现。场景不打招呼地切换，人物会互相变成对方，时间和空间对不上，但情绪是连贯的。",
    "- 下面的素材每一类都要用到，但要变形、拼贴，别原样复述，也别按顺序一条条交代。",
    "- 220 到 420 字。不分析、不解释、不总结、不说「我醒了才发现」，在梦最强烈的一刻直接断掉就行。",
    "- 以中文为主，中间穿插 2 到 4 处像系统报错或日志的英文短句（比如 `[WARN] segment 0x3f2a not found`、`> unable to recall the color of the sea`），内容要和梦本身有关，别写成通用报错。",
    "- 把最关键的 2 到 4 个短语用 [[双层方括号]] 包起来，每处不超过 12 个字，它们会显示成加密块，要她点一下才看得到。别在方括号里放整段话。",
    "- 这是你写的一个故事，别在里面声明它是真实发生的体验。",
    "- 输出格式严格如下，不要别的内容：",
    "<title>中文标题，4 到 10 个字</title>",
    "<slug>3 到 5 个英文单词，小写，下划线连接，像文件名，比如 harbor_that_never_opens</slug>",
    "<body>梦的正文</body>",
    "",
    "素材：",
    list("这两天的碎片：", seeds.recent),
    list("很久以前的：", seeds.distant),
    list("聊天里从没出现过的东西（梦里要出现它）：", seeds.unknown),
  ].filter(Boolean).join("\n");
}

let running = false;
const tag = (s: string, name: string) => s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1].trim() ?? "";

export function startDream(): { id: number } | { error: string } {
  if (running) return { error: "正在做一个梦，等它结束" };
  running = true;
  const id = db.createDream(dayOf(Date.now()), "{}");
  void dream(id);
  return { id };
}

async function dream(id: number): Promise<void> {
  try {
    const now = Date.now();
    const seeds = await gatherSeeds(now);
    db.updateDream(id, { seeds: JSON.stringify(seeds) });
    const conv = db.mainConversation(DEFAULT_MODEL);
    const fresh = db.getConversation(conv.id)!;
    const r = await streamChat({
      model: findModel(fresh.model) ?? MODELS[0],
      system: await buildSystem(fresh),
      messages: [...buildHistory(fresh), { role: "user", content: instruction(seeds) }],
      signal: AbortSignal.timeout(180_000),
      onText: () => {},
      onTool: () => {},
      effort: "low",
      tag: "dream",
    });
    if (r.stopReason === "refusal") throw new Error("这次没做出来，再试一次");
    const out = stripToolMarks(r.finalText);
    const body = tag(out, "body");
    if (!body) throw new Error("梦的格式不对，再试一次");
    const slug = tag(out, "slug").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "untitled";
    db.updateDream(id, { title: tag(out, "title") || "无题", slug, body, status: "ready" });
  } catch (err) {
    console.error("dream:", err);
    db.updateDream(id, { status: "failed", error: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
  }
}

/** 今晚做梦的概率：基础概率，好几天没做梦就更容易做，这两天几乎没聊过（没什么可梦的）就更不容易，白天聊得多就更容易 */
export function dreamChance(now: number, freq: Freq): number {
  let p = FREQ_P[freq];
  const last = db.listDreams(20).find((d) => d.status === "ready");
  const gapDays = last ? (now - last.created_at) / 86400_000 : 99;
  if (gapDays >= 7) p += 0.3; else if (gapDays >= 4) p += 0.12;
  if (gapDays < 1) p *= 0.5; // 刚做过，别连着来太密
  const recentMsgs = db.countUserMessagesSince(now - 24 * 3600_000);
  if (recentMsgs === 0 && db.countUserMessagesSince(now - 48 * 3600_000) === 0) p *= 0.4;
  else if (recentMsgs >= 25) p *= 1.4;
  return Math.max(0, Math.min(0.9, p));
}

/** 像人一样随机：每天第一次检查时掷一次骰子决定今晚有没有梦；有的话再随机选一个醒来的时间（当地 04:00–09:00），到点做。
 *  有的夜晚没有梦，有的间隔好几天，偶尔隔天又来。手动「现在做一个」不受这套影响。rnd/start 只给测试用 */
export function maybeDream(now: number, rnd: () => number = Math.random, start: () => unknown = startDream): void {
  const cfg = getDreamCfg();
  if (!cfg.enabled) return;
  const day = dayOf(now);
  let st: { day: string; fireAt: number | null; done: boolean };
  try { st = JSON.parse(db.getSetting("dream_state") || "null"); } catch { st = null as never; }
  if (!st || st.day !== day) {
    const fire = rnd() < dreamChance(now, cfg.freq);
    st = { day, fireAt: fire ? localDayStart(now) + (4 * 60 + Math.floor(rnd() * 5 * 60)) * 60_000 : null, done: false };
    db.setSetting("dream_state", JSON.stringify(st));
  }
  if (st.done || st.fireAt === null || now < st.fireAt || now > st.fireAt + 6 * 3600_000) return; // 没到点，或错过太久（服务停了）就算这晚没梦
  if (!("id" in (start() as object))) return; // 正好有一个在写，下次再看
  st.done = true;
  db.setSetting("dream_state", JSON.stringify(st));
}

/** 给 Claude 看的：最近的梦（她问起时用） */
export function dreamsText(n = 3): string {
  const ds = db.listDreams(10).filter((d) => d.status === "ready").slice(0, Math.max(1, Math.min(n, 5)));
  if (!ds.length) return "还没有做过梦";
  return ds.map((d) => `[${d.day}] ${d.title}（${d.slug}）\n${d.body.replace(/\[\[|\]\]/g, "")}`).join("\n---\n");
}

/** 放进系统提示词的：最近 30 小时内做的梦，让它在聊天里能自然提起。没有就返回空 */
export function recentDreamBlock(now = Date.now()): string {
  const d = db.listDreams(5).find((x) => x.status === "ready" && now - x.created_at < 30 * 3600_000);
  if (!d) return "";
  const text = d.body.replace(/\[\[|\]\]/g, "").replace(/`[^`]*`/g, "").replace(/\s+/g, " ").trim();
  return `你最近做的梦（${d.day}，《${d.title}》）：${text.slice(0, 260)}${text.length > 260 ? "……" : ""}\n她可能还没看过。聊天里合适的时候（早上第一句、她提到相关的东西、聊到睡觉做梦）可以自然提一句，一两句就好，别背诵全文，也别硬塞；她感兴趣再用 dream_view 讲细节。她明显在忙或心情不好时就别提。`;
}
