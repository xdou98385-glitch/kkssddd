// 主动消息：定时「心跳」让 Claude 决定要不要主动找小月；要的话写进对话并推送到手机。
import * as db from "./db.ts";
import { DEFAULT_MODEL, MODELS, findModel, streamChat } from "./claude.ts";
import { buildHistory, buildSystem } from "./context.ts";
import { activitySummary, deviceEnabled } from "./device.ts";
import { sendPush } from "./push.ts";

export interface ProactiveSettings {
  enabled: boolean;
  quietStart: string; // 安静时段开始，HH:MM
  quietEnd: string; // 安静时段结束
  maxPerDay: number; // 每天最多主动发几条
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
    if (!Number.isInteger(n) || n < 1 || n > 10) return "每天条数要在 1 到 10 之间";
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

function instruction(s: ProactiveSettings, now: number, lastAt: number | null, force: boolean): string {
  return [
    "[系统消息，不是小月说的，别回应这条消息本身]",
    `现在是 ${describeNow(s.tz, now)}（${s.tz}）。${lastAt ? `距离你们上次说话过了 ${describeGap(now - lastAt)}。` : "你们还没聊过。"}`,
    deviceEnabled ? activitySummary(180, s.tz, now) : "",
    "你可以主动给小月发一条消息，也可以什么都不发。",
    "- 只有真有话想说才发：接着之前聊的事、问问她在读的书或在做的事、关心一下（睡眠、吃饭）、分享刚想到的东西。别为了发而发。",
    "- 一条，短，像朋友随手发的。不要自我介绍，不要说「我是来主动联系你的」，不要问候套话，不要说教。",
    "- 不想发就只回复 [skip]，什么都别多说。",
    "- 你的回复只能是要发给她的话本身（或 [skip]），不要加任何前后说明。",
    force ? "这次是小月在设置里手动点了「现在试一条」来测试，请务必真的写一条，不要 [skip]。" : "",
  ].filter(Boolean).join("\n");
}

export interface HeartbeatResult {
  status: "sent" | "skipped";
  reason?: string;
  text?: string;
  pushed?: number;
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

    if (!opts.force) {
      if (!s.enabled) return skip("没有开启主动消息");
      if (!db.listPushSubs().length) return skip("还没有设备开启通知");
      if (inQuietHours(s, now)) return skip("安静时段");
      if (last?.role === "assistant" && last.kind === "proactive") return skip("上一条主动消息她还没回");
      if (last && now - last.created_at < 45 * 60_000) return skip("刚聊过");
      const st = db.proactiveStats(conv.id, localDayStart(s.tz, now));
      if (st.count >= s.maxPerDay) return skip("今天已经发够了");
      if (st.lastAt && now - st.lastAt < 3 * 3600_000) return skip("离上一条主动消息太近");
    }

    const fresh = db.getConversation(conv.id)!;
    const model = findModel(fresh.model) ?? MODELS[0];
    const result = await streamChat({
      model,
      system: await buildSystem(fresh),
      messages: [...buildHistory(fresh), { role: "user", content: instruction(s, now, last?.created_at ?? null, Boolean(opts.force)) }],
      signal: AbortSignal.timeout(120_000),
      onText: () => {},
      onTool: () => {},
    });

    // 只取最后一轮的文字：调用工具之前说的话不算
    const text = result.finalText.trim();
    if (!text || /^\[skip\]/i.test(text) || result.stopReason === "refusal") return skip("Claude 觉得现在不用发");
    db.addMessage(conv.id, "assistant", text, [], "proactive");
    const pushed = (await sendPush({ title: "Claude", body: preview(text), url: "/" })).sent;
    return { status: "sent", text, pushed };
  } catch (err) {
    console.error("proactive:", err);
    return skip("出错：" + (err instanceof Error ? err.message : String(err)));
  } finally {
    running = false;
  }
}

/** 每隔一段时间跑一次心跳；间隔用 PROACTIVE_EVERY_MIN 调（默认 90 分钟） */
export function startScheduler(): void {
  const minutes = Math.max(5, Number(process.env.PROACTIVE_EVERY_MIN ?? 90) || 90);
  setInterval(() => {
    void heartbeat().then((r) => console.log(`proactive: ${r.status}${r.reason ? " (" + r.reason + ")" : ""}`));
  }, minutes * 60_000).unref();
}
