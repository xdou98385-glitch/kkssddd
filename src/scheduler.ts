// 到点发消息：提醒（她让你记的）和 checkin（Claude 自己约好要找她的时间）。每 30 秒看一次。
// 到点时让 Claude 现写那句话，发之前它可以先用工具（天气、日程、邮箱……）再说。
import * as db from "./db.ts";
import { DEFAULT_MODEL, MODELS, findModel, streamChat } from "./claude.ts";
import { buildHistory, buildSystem, stripToolMarks } from "./context.ts";
import { userTz } from "./device.ts";
import { getProactive, inQuietHours } from "./proactive.ts";
import { sendPush } from "./push.ts";
import { fmtLocal } from "./schedule.ts";

const CHECKINS_PER_DAY = 3;
const preview = (t: string) => t.replace(/[*_`#>~]/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
let running = false;

function instruction(it: db.Scheduled, tz: string, now: number): string {
  const head = ["[系统消息，不是小月说的，别回应这条消息本身]", `现在是 ${fmtLocal(now, tz)}（${tz}）。`];
  if (it.kind === "reminder") {
    return [
      ...head,
      `她之前让你在这个时间提醒她：「${it.text}」。`,
      "- 现在写一两句提醒她，像朋友随口说的，别念公文。可以先用工具看一眼相关的东西（比如出门前看天气、看她的日程）再说，有用才查。",
      "- 必须发，不要 [skip]。回复只能是要发给她的话本身，不要加前后说明。",
    ].join("\n");
  }
  return [
    ...head,
    `你之前给自己约了现在找她，原因：「${it.text}」。`,
    "- 先想想现在还合不合适：她这段时间的状态、刚聊过什么。可以先用工具看一眼（她的手机动态、日程、天气、邮箱）再决定。",
    "- 合适就发一两句，像朋友随口发的，不要自我介绍，不要说「我是按约定来找你的」。已经不合适就只回复 [skip]。",
    "- 回复只能是要发给她的话本身（或 [skip]），不要加前后说明。",
  ].join("\n");
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
function checkinsToday(now: number): number {
  try { const u = JSON.parse(db.getSetting("checkin_usage") || "{}"); return u.day === dayKey(now) ? Number(u.n) || 0 : 0; } catch { return 0; }
}
const noteCheckin = (now: number) => db.setSetting("checkin_usage", JSON.stringify({ day: dayKey(now), n: checkinsToday(now) + 1 }));

async function fire(it: db.Scheduled): Promise<void> {
  const now = Date.now();
  const pro = getProactive();
  const tz = userTz() === "UTC" ? "Asia/Tokyo" : userTz();
  const conv = db.mainConversation(DEFAULT_MODEL);

  if (it.kind === "checkin") {
    if (inQuietHours(pro, now)) { db.postponeScheduled(it.id, now + 30 * 60_000); return; } // 安静时段先往后挪
    if (checkinsToday(now) >= CHECKINS_PER_DAY) { db.setScheduledStatus(it.id, "skipped"); return; }
  }

  let text = "";
  let tools: string[] = [];
  try {
    const fresh = db.getConversation(conv.id)!;
    const model = findModel(fresh.model) ?? MODELS[0];
    const r = await streamChat({
      model,
      system: await buildSystem(fresh),
      messages: [...buildHistory(fresh), { role: "user", content: instruction(it, tz, now) }],
      signal: AbortSignal.timeout(120_000),
      onText: () => {},
      onTool: () => {},
      effort: "medium",
      tag: "scheduled",
    });
    text = r.stopReason === "refusal" ? "" : r.finalText.trim();
    tools = r.toolsUsed;
    if (it.kind === "checkin" && (!text || /^\[skip\]/i.test(text))) { db.setScheduledStatus(it.id, "skipped"); return; }
  } catch (err) {
    console.error("scheduled:", err instanceof Error ? err.message : err);
    if (it.kind === "checkin") { db.setScheduledStatus(it.id, "failed"); return; }
  }
  if (!text || /^\[skip\]/i.test(text)) text = `提醒：${it.text}`; // 提醒是她要的，Claude 那边出了岔子也得发出去
  db.addMessage(conv.id, "assistant", stripToolMarks(text), [], "remind", tools);
  if (it.kind === "checkin") noteCheckin(now);
  db.setScheduledStatus(it.id, "done");
  if (db.listPushSubs().length) await sendPush({ title: "Claude", body: preview(text), url: "/" }).catch(() => {});
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const it of db.dueScheduled(Date.now())) await fire(it);
  } catch (err) {
    console.error("scheduler:", err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

export const __tick = tick; // 只给测试用
export function startSchedulerTick(): void {
  setInterval(() => void tick(), 30_000).unref();
  void tick(); // 服务重启时，补发停机期间到点的提醒
}
