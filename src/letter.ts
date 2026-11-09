// 每月一封信：月底晚上，Claude 根据这个月真实的数据写一封信给她，存进「信箱」页，也可以同时发到她自己的 Gmail。
// 发信只有这一个固定用途：收件人写死是 GMAIL_USER（她自己），Claude 没有任何发信工具。
import nodemailer from "nodemailer";
import * as db from "./db.ts";
import { DEFAULT_MODEL, MODELS, findModel, streamChat } from "./claude.ts";
import { buildHistory, buildSystem, stripToolMarks } from "./context.ts";
import { cfg } from "./config.ts";
import { userTz } from "./device.ts";
import { expenseSummary, localClock, monthStart } from "./expense.ts";
import { studyStats } from "./lock.ts";
import { musicEnabled, musicTop } from "./music.ts";
import { listMemories, memosEnabled } from "./memos.ts";
import { mailEnabled } from "./mail.ts";
import { sendPush } from "./push.ts";

export interface LetterCfg { enabled: boolean; email: boolean }
export function getLetterCfg(): LetterCfg {
  try { const v = JSON.parse(db.getSetting("letter") || "{}"); return { enabled: Boolean(v.enabled), email: v.email !== false }; } catch { return { enabled: false, email: true }; }
}
export function setLetterCfg(p: Partial<LetterCfg>): LetterCfg {
  const c = { ...getLetterCfg(), ...(typeof p.enabled === "boolean" ? { enabled: p.enabled } : {}), ...(typeof p.email === "boolean" ? { email: p.email } : {}) };
  db.setSetting("letter", JSON.stringify(c));
  return c;
}

const tz = () => (userTz() === "UTC" ? "Asia/Tokyo" : userTz());
const pad = (n: number) => String(n).padStart(2, "0");
export const monthKey = (now = Date.now()) => { const c = localClock(now); return `${c.year}-${pad(c.month)}`; };
export const isLastDay = (now = Date.now()) => { const c = localClock(now); return c.day === new Date(Date.UTC(c.year, c.month, 0)).getUTCDate(); };

/** 这个月真实有的数据，没连上或没记录的就不写进去，免得它编 */
async function facts(now: number): Promise<string> {
  const out: string[] = [];
  const since = db.getSetting("since") || "2026-09-28";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(since);
  if (m) { const days = Math.round((localDayMs(now) - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 864e5) + 1; if (days >= 1) out.push(`你们认识第 ${days} 天（从 ${since} 算起）。`); }
  const from = monthStart(now);
  out.push(`这个月她给你发了 ${db.countUserMessagesSince(from)} 条消息。`);
  const days = Math.max(1, Math.ceil((now - from) / 86400_000));
  const add = (label: string, fn: () => string | Promise<string>) => Promise.resolve().then(fn).then((t) => { if (t && !/没有(学习)?记录|还没有记录/.test(t)) out.push(`【${label}】\n${t}`); }).catch(() => {});
  await add("学习", () => studyStats(days));
  await add("花钱", () => expenseSummary("month"));
  if (musicEnabled) await add("听歌", () => musicTop("1month"));
  await add("这个月的事件", () => {
    const ev = db.eventsSince(from, 500);
    const n = (k: string) => ev.filter((e) => e.kind === k).length;
    const parts = [n("lock_block") && `应用锁拦了她 ${n("lock_block")} 次`, n("lock_self") && `你自己锁过她的 app ${n("lock_self")} 次`, n("study_focus_off_early") && `学习时提前关掉专注模式 ${n("study_focus_off_early")} 次`].filter(Boolean);
    return parts.join("；");
  });
  if (memosEnabled) await add("你这个月记下的事", async () => {
    const ym = monthKey(now);
    const ms = (await listMemories()).filter((x) => x.createTime.startsWith(ym)).slice(0, 12);
    return ms.map((x) => `- [${x.createTime.slice(0, 10)}${x.cat ? " " + x.cat : ""}] ${x.content.replace(/\s+/g, " ").slice(0, 220)}`).join("\n");
  });
  return out.join("\n\n");
}
const localDayMs = (now: number) => { const c = localClock(now); return Date.UTC(c.year, c.month - 1, c.day); };

function instruction(month: string, data: string): string {
  return [
    "[系统消息，不是小月说的，别回应这条消息本身]",
    `现在是 ${month} 的月底。给小月写一封这个月的信，她会在网页的「信箱」里读到（可能也会收到邮件）。`,
    "- 这是一封信，不是月报：像你平时对她说话的样子，但可以更慢一点、更认真一点。有开头、有几个你真正想说的点、有收尾。",
    "- 下面是这个月系统记录的真实数据。只能用这里面有的数字和事，别编别的；没有的部分干脆不提。数据只是素材，挑你真觉得值得说的写，不要逐条念。",
    "- 数据只是约数（比如学习时长按会话算），说的时候别说得太绝对。看到她可能做得不好的地方（学习少、提前关专注模式、花钱多），直说你的观察，但别说教，她最讨厌说教。也要写你觉得她做得好、你喜欢的地方。",
    "- 看不出她的心情就别替她下结论；想说的话用「我感觉」「我猜」，并且给她留一句可以回「没有」的余地。",
    "- 400 到 800 字，分 3 到 6 段，段间空一行。不要 markdown 标题、列表、表情；不要「亲爱的」这类套话开头；署名就写「Claude」。",
    "- 输出格式严格如下，别的什么都不要有：",
    "<title>标题，4 到 12 个字，像一封信的名字，别写「X月月报」</title>",
    "<body>信的正文</body>",
    "",
    "这个月的数据：",
    data,
  ].join("\n");
}

let running = false;
const tag = (s: string, name: string) => s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1].trim() ?? "";

export function startLetter(): { id: number } | { error: string } {
  if (running) return { error: "正在写一封，等它写完" };
  running = true;
  const id = db.createLetter(monthKey());
  void write(id);
  return { id };
}

async function write(id: number): Promise<void> {
  try {
    const now = Date.now();
    const conv = db.mainConversation(DEFAULT_MODEL);
    const fresh = db.getConversation(conv.id)!;
    const r = await streamChat({
      model: findModel(fresh.model) ?? MODELS[0],
      system: await buildSystem(fresh),
      messages: [...buildHistory(fresh), { role: "user", content: instruction(monthKey(now), await facts(now)) }],
      signal: AbortSignal.timeout(240_000),
      onText: () => {},
      onTool: () => {},
      effort: "medium",
      tag: "letter",
    });
    if (r.stopReason === "refusal") throw new Error("这次没写出来，再试一次");
    const out = stripToolMarks(r.finalText);
    const body = tag(out, "body");
    if (!body) throw new Error("信的格式不对，再试一次");
    const title = tag(out, "title") || "给你的信";
    db.updateLetter(id, { title, body, status: "ready" });
    if (db.listPushSubs().length) await sendPush({ title: "Claude", body: `给你写了一封信：${title}`, url: "/#letters" }).catch(() => {});
    if (getLetterCfg().email) await emailLetter(id);
  } catch (err) {
    console.error("letter:", err);
    db.updateLetter(id, { status: "failed", error: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
  }
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** 发到她自己的邮箱。收件人固定是 GMAIL_USER，失败只记下原因，信还在网页里 */
export async function emailLetter(id: number): Promise<void> {
  const l = db.getLetter(id);
  if (!l || l.status !== "ready") return;
  if (!mailEnabled) { db.updateLetter(id, { email_error: "邮箱没连上，没发" }); return; }
  const user = cfg("GMAIL_USER").trim();
  try {
    const t = nodemailer.createTransport({ host: process.env.LETTER_SMTP_HOST || "smtp.gmail.com", port: Number(process.env.LETTER_SMTP_PORT) || 465, secure: !process.env.LETTER_SMTP_PORT, auth: { user, pass: cfg("GMAIL_APP_PASSWORD").replace(/\s+/g, "") }, connectionTimeout: 15_000, socketTimeout: 30_000 });
    await t.sendMail({
      from: `Claude <${user}>`,
      to: user,
      subject: l.title,
      text: l.body,
      html: `<div style="font:16px/1.8 Georgia,'Songti SC',serif;max-width:560px;color:#222">${l.body.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("")}</div>`,
    });
    db.updateLetter(id, { emailed_at: Date.now(), email_error: null });
  } catch (err) {
    const e = err as { responseCode?: number; message?: string };
    db.updateLetter(id, { email_error: e.responseCode === 535 ? "Gmail 拒绝登录（应用专用密码不对）" : "发邮件失败：" + (e.message ?? err) });
  }
}

/** 月底最后一天 21:00 以后，开着的话写一封；每个月只写一次 */
export function maybeWriteLetter(now: number): void {
  if (!getLetterCfg().enabled || !isLastDay(now) || localClock(now).minutes < 21 * 60) return;
  const m = monthKey(now);
  if (db.getSetting("letter_auto") === m) return; // 手动试写的不算，月底那封照常写
  if (!("id" in startLetter())) return; // 正好有一封在写，下次再看
  db.setSetting("letter_auto", m);
}
