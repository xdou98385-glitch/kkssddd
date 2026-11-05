// 主动消息：定时「心跳」让 Claude 决定要不要主动找小月；要的话写进对话并推送到手机。
import * as db from "./db.ts";
import { DEFAULT_MODEL, MODELS, findModel, streamChat } from "./claude.ts";
import { buildHistory, buildSystem, stripToolMarks } from "./context.ts";
import { activitySummary, deviceEnabled } from "./device.ts";
import { sendPush } from "./push.ts";

export interface ProactiveSettings {
  enabled: boolean;
  quietStart: string; // 安静时段开始，HH:MM
  quietEnd: string; // 安静时段结束
  maxPerDay: number; // 每天最多主动发几条，0 = 不限
  tz: string; // 她所在的时区（由浏览器上报）
}

const DEFAULTS: ProactiveSettings = { enabled: false, quietStart: "23:00", quietEnd: "09:00", maxPerDay: 3, tz: "UTC" };

const validTz = (tz: string) => {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function getProactive(): ProactiveSettings {
  const raw = db.getSetting("proactive");
  return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
}

/** 合并并校验后保存；不合法返回原因 */
export function updateProactive(patch: Partial<ProactiveSettings>): ProactiveSettings | string {
  const s = getProactive();
  if (patch.enabled !== undefined) s.enabled = Boolean(patch.enabled);
  if (patch.quietStart !== undefined) { if (!HHMM.test(patch.quietStart)) return "安静时段开始时间格式不对"; s.quietStart = patch.quietStart; }
  if (patch.quietEnd !== undefined) { if (!HHMM.test(patch.quietEnd)) return "安静时段结束时间格式不对"; s.quietEnd = patch.quietEnd; }
  if (patch.maxPerDay !== undefined) {
    const n = Number(patch.maxPerDay);
    if (!Number.isInteger(n) || n < 0 || n > 10) return "每天条数要在 1 到 10 之间，0 表示不限";
    s.maxPerDay = n;
  }
  if (patch.tz !== undefined) { if (!validTz(patch.tz)) return "时区不对"; s.tz = patch.tz; }
  db.setSetting("proactive", JSON.stringify(s));
  return s;
}

// ---- 时间工具（都按她的时区算）----
function localMinutes(tz: string, ms: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return (get("hour") % 24) * 60 + get("minute");
}
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

export function inQuietHours(s: ProactiveSettings, ms: number): boolean {
  const now = localMinutes(s.tz, ms), a = toMin(s.quietStart), b = toMin(s.quietEnd);
  if (a === b) return false;
  return a < b ? now >= a && now < b : now >= a || now < b; // 跨午夜的情况（23:00-09:00）
}
const localDayStart = (tz: string, ms: number) => ms - localMinutes(tz, ms) * 60_000 - (ms % 60_000);

function describeNow(tz: string, ms: number): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: tz, dateStyle: "full", timeStyle: "short", hour12: false }).format(ms);
}
function describeGap(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 90 ? `${m} 分钟` : m < 36 * 60 ? `${Math.round(m / 60)} 小时` : `${Math.round(m / 1440)} 天`;
}
const preview = (t: string) => t.replace(/[*_`#>~]/g, "").replace(/\s+/g, " ").trim().slice(0, 100);

const MIN_WAKE_MIN = Math.max(10, Number(process.env.PROACTIVE_MIN_WAKE_MIN ?? 30) || 30); // Claude 自己定下次醒来时间的下限
const MAX_WAKE_MIN = 8 * 60;
const RETRY_MIN = 15; // 被规则挡住（安静时段等，没调 Claude）时，隔多久再看一次

/** 取出回复末尾的 [next: 45m] / [next: 3h]，返回去掉标记后的文字和分钟数（没写或写错返回 null） */
export function parseNext(raw: string): { text: string; minutes: number | null } {
  const m = raw.match(/\[next:\s*(\d+(?:\.\d+)?)\s*(m|min|h|hr)?\s*\]/i);
  const text = raw.replace(/\[next:[^\]]*\]/gi, "").trim();
  if (!m) return { text, minutes: null };
  const v = Number(m[1]) * (/^h/i.test(m[2] ?? "") ? 60 : 1);
  return { text, minutes: Math.max(MIN_WAKE_MIN, Math.min(MAX_WAKE_MIN, Math.round(v))) };
}

/** 没回时，下一条主动消息至少要隔多久：越没回隔得越久；连着 4 条都没回就停下，等她先说话 */
export function requiredGapMs(unanswered: number): number | null {
  const h = [1, 4, 12, 24][unanswered];
  return h === undefined ? null : h * 3600_000;
}

const ACTIVITY_WINDOW_MIN = 180; // 心跳时附带的手机动态覆盖多久

function instruction(s: ProactiveSettings, now: number, lastAt: number | null, force: boolean, unanswered = 0): string {
  return [
    "[系统消息，不是小月说的，别回应这条消息本身]",
    `现在是 ${describeNow(s.tz, now)}（${s.tz}）。${lastAt ? `距离你们上次说话过了 ${describeGap(now - lastAt)}。` : "你们还没聊过。"}`,
    deviceEnabled ? activitySummary(ACTIVITY_WINDOW_MIN, s.tz, now) : "",
    deviceEnabled ? `- 上面的手机动态只覆盖最近 ${ACTIVITY_WINDOW_MIN} 分钟。提到她用手机的情况，只能说上面写了的，次数照抄，没写的数字别报，也别说「一上午」「一整天」这种超出这段范围的话；想知道更早的情况就先用 device_activity 工具查。` : "",
    "你可以主动给小月发一条消息，也可以什么都不发。",
    "- 发之前可以先用工具看一眼再决定说什么：她的手机动态、日程、天气、邮箱、在听什么、联网搜一下都行。只在确实能让这句话更具体、更有用的时候用，别为了用而用。",
    "- 如果她允许你自己上锁（app_lock_auto_config 设过名单），而你从手机动态看到她深夜还在刷那些 app，可以先用 app_lock_self 锁一段时间，再发消息告诉她锁了什么、为什么。别没证据就锁。",
    "- 如果你想在某个具体时间再找她（而不是现在），不发这条，用 schedule_checkin 约一个时间，然后回复 [skip]。",
    "- 只有真有话想说才发：接着之前聊的事、问问她在读的书或在做的事、关心一下（睡眠、吃饭）、分享刚想到的东西。别为了发而发。",
    "- 一条，短，像朋友随手发的。不要自我介绍，不要说「我是来主动联系你的」，不要问候套话，不要说教。",
    "- 不想发就只回复 [skip]，什么都别多说。",
    unanswered ? `- 你已经连着发了 ${unanswered} 条主动消息，她都还没回。别催，别重复同一个话题，别问「怎么不理我」；要发就换个很轻的方式，多数时候 [skip] 更好。` : "",
    "- 你的回复只能是要发给她的话本身（或 [skip]），不要加任何前后说明。",
    `- 回复最后另起一行，写 [next: 45m] 或 [next: 3h] 这样的标记，告诉系统你想多久之后再醒来看一次（最短 ${MIN_WAKE_MIN} 分钟，最长 8 小时）。刚聊得热、她可能马上回，就短一点；深夜、她在忙、或者她还没回你上一条，就长一点。发了消息或 [skip] 都要写。这一行不会发给她。`,
    force ? "这次是小月在设置里手动点了「现在试一条」来测试，请务必真的写一条，不要 [skip]。" : "",
  ].filter(Boolean).join("\n");
}

export interface HeartbeatResult {
  status: "sent" | "skipped";
  reason?: string;
  text?: string;
  pushed?: number;
  pushErrors?: string[];
  called?: boolean; // 这次真的调了 Claude（花了额度）
  nextMin?: number | null; // Claude 自己定的下次醒来时间（分钟）
}

let running = false;

/** 跑一次心跳。force=true 跳过所有限制（测试用）。 */
export async function heartbeat(opts: { force?: boolean } = {}): Promise<HeartbeatResult> {
  const skip = (reason: string): HeartbeatResult => ({ status: "skipped", reason });
  if (running) return skip("上一次还没跑完");
  running = true;
  try {
    const s = getProactive();
    const now = Date.now();
    const conv = db.mainConversation(DEFAULT_MODEL);
    const last = db.lastMessage(conv.id);
    const tail = db.trailingProactive(conv.id);

    if (!opts.force) {
      if (!s.enabled) return skip("没有开启主动消息");
      if (!db.listPushSubs().length) return skip("还没有设备开启通知");
      if (inQuietHours(s, now)) return skip("安静时段");
      if (last && now - last.created_at < 45 * 60_000) return skip("刚聊过");
      const st = db.proactiveStats(conv.id, localDayStart(s.tz, now));
      if (s.maxPerDay > 0 && st.count >= s.maxPerDay) return skip("今天已经发够了");
      const gap = requiredGapMs(tail.count);
      if (gap === null) return skip("连着发了几条她都没回，先不打扰了，等她先说话");
      if (tail.lastAt && now - tail.lastAt < gap) return skip(`她还没回上一条，要隔久一点（${Math.round(gap / 3600_000)} 小时）`);
    }

    const fresh = db.getConversation(conv.id)!;
    const model = findModel(fresh.model) ?? MODELS[0];
    const result = await streamChat({
      model,
      system: await buildSystem(fresh),
      messages: [...buildHistory(fresh), { role: "user", content: instruction(s, now, last?.created_at ?? null, Boolean(opts.force), tail.count) }],
      signal: AbortSignal.timeout(120_000),
      onText: () => {},
      onTool: () => {},
      effort: "medium", // 只是决定要不要发一句话，不用想太深；聊天仍用模型默认的 high
      tag: "proactive",
    });

    // 只取最后一轮的文字：调用工具之前说的话不算
    const { text, minutes } = parseNext(result.finalText);
    if (!text || /^\[skip\]/i.test(text) || result.stopReason === "refusal") return { ...skip("Claude 觉得现在不用发"), called: true, nextMin: minutes };
    // 心跳指令里附带了手机动态（由代码取的真实数据），记成用过 device_activity，否则之后会被当成"没查就说"
    const sources = deviceEnabled && !result.toolsUsed.includes("device_activity") ? [...result.toolsUsed, "device_activity"] : result.toolsUsed;
    db.addMessage(conv.id, "assistant", stripToolMarks(text), [], "proactive", sources);
    const push = await sendPush({ title: "Claude", body: preview(text), url: "/" });
    return { status: "sent", text, pushed: push.sent, pushErrors: push.errors, called: true, nextMin: minutes };
  } catch (err) {
    console.error("proactive:", err);
    return skip("出错：" + (err instanceof Error ? err.message : String(err)));
  } finally {
    running = false;
  }
}

/** 默认节拍用 PROACTIVE_EVERY_MIN（默认 90 分钟）；Claude 在回复末尾写了 [next: …] 就按它写的来。
 *  被规则挡住（没调 Claude）的只隔 15 分钟再看，不花额度。下次醒来的时间存在库里，重启不丢。 */
export function startScheduler(): void {
  const dflt = Math.max(5, Number(process.env.PROACTIVE_EVERY_MIN ?? 90) || 90);
  const tick = async () => {
    const due = Number(db.getSetting("proactive_next", "0")) || 0;
    if (Date.now() < due) return;
    const r = await heartbeat();
    const mins = r.called ? (r.nextMin ?? dflt) : RETRY_MIN;
    db.setSetting("proactive_next", String(Date.now() + mins * 60_000));
    console.log(`proactive: ${r.status}${r.reason ? " (" + r.reason + ")" : ""}${r.called ? `，下次 ${mins} 分钟后${r.nextMin ? "（Claude 定的）" : ""}` : ""}`);
  };
  setInterval(() => void tick(), 60_000).unref();
}
