// 应用锁（软锁）：iPhone 快捷指令的「打开 App」自动化在她打开某个 app 时问一下 /api/gate，被拦就弹出提示并回到主屏幕。
// 规则：时间窗（比如 23:00–07:00 不许开抖音）、每天用时上限，都可以带过期时间（比如「学习到 22:00」）。
// 想临时放行要跟 Claude 说，由它判断；每个 app 每天最多放行 3 次、每次最多 30 分钟（上限由代码守着，Claude 说了不算）。
// 这是靠自觉的软锁：她随时能在快捷指令里关掉自动化，这个事实不会假装不存在。
import * as db from "./db.ts";
import { eventHooks, userTz } from "./device.ts";
import { sendPush } from "./push.ts";
import { fmtLocal, zonedToMs } from "./schedule.ts";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const tzNow = () => (userTz() === "UTC" ? "Asia/Tokyo" : userTz());
const norm = (s: string) => s.trim().toLowerCase();
const toMin = (h: string) => { const [a, b] = h.split(":").map(Number); return a * 60 + b; };

function localMinutes(ms: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(ms);
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return (g("hour") % 24) * 60 + g("minute");
}
const localDayStart = (ms: number, tz: string) => ms - localMinutes(ms, tz) * 60_000 - (ms % 60_000);

export function addRule(a: { app: string; kind: string; start: string; end: string; limit_minutes: number; until: string; note: string }): string {
  const app = a.app.trim().slice(0, 30);
  if (!app) throw new Error("没写是哪个 app");
  let expires = 0;
  if (a.until && a.until.trim()) {
    const t = zonedToMs(a.until, tzNow());
    if (t === null) throw new Error("until 要写成她当地时间 YYYY-MM-DD HH:MM，不设过期就留空");
    if (t <= Date.now()) throw new Error("过期时间已经过了");
    expires = t;
  }
  let start = "", end = "", limit = 0;
  if (a.kind === "window") {
    if (!HHMM.test(a.start) || !HHMM.test(a.end) || a.start === a.end) throw new Error("时间窗要写 start / end，格式 HH:MM（可以跨午夜，比如 23:00 到 07:00）");
    start = a.start; end = a.end;
  } else if (a.kind === "limit") {
    limit = Math.round(Number(a.limit_minutes));
    if (!(limit >= 5 && limit <= 600)) throw new Error("每天用时上限要在 5 到 600 分钟之间");
  } else throw new Error("kind 只能是 window 或 limit");
  if (db.listAppRules().length >= 30) throw new Error("规则已经有 30 条了，先删一些");
  const id = db.addAppRule({ app, kind: a.kind, start, end, limit_min: limit, expires_at: expires, note: a.note.trim().slice(0, 80) });
  return `已锁 #${id}：${app}，${a.kind === "window" ? `${start}–${end} 不让开` : `每天最多 ${limit} 分钟`}${expires ? `，到 ${fmtLocal(expires, tzNow())} 失效` : ""}。要让这条生效，快捷指令里得有「打开 ${app}」的自动化去问服务器。`;
}

export function listRules(): string {
  db.purgeExpiredAppRules(Date.now());
  const rs = db.listAppRules();
  if (!rs.length) return "现在没有任何应用锁规则";
  const unlocks = readUnlocks();
  return rs.map((r) => `- #${r.id} ${r.app}：${r.kind === "window" ? `${r.start}–${r.end} 不让开` : `每天最多 ${r.limit_min} 分钟`}${r.expires_at ? `，到 ${fmtLocal(r.expires_at, tzNow())} 失效` : ""}${r.note ? `（${r.note}）` : ""}${unlocks[norm(r.app)]?.until > Date.now() ? `【临时放行到 ${fmtLocal(unlocks[norm(r.app)].until, tzNow())}】` : ""}`).join("\n");
}

export function removeRule(id: number): string {
  if (!db.deleteAppRule(id)) throw new Error(`没有 #${id} 这条规则`);
  return `已删除规则 #${id}`;
}

// ---- 临时放行 ----
type Unlocks = Record<string, { until: number; day: string; n: number }>;
const readUnlocks = (): Unlocks => { try { return JSON.parse(db.getSetting("app_unlocks") || "{}"); } catch { return {}; } };
const dayKey = () => new Date().toISOString().slice(0, 10);

export function unlock(app: string, minutes: number): string {
  const key = norm(app);
  if (!key) throw new Error("没写是哪个 app");
  const m = Math.max(1, Math.min(30, Math.round(Number(minutes) || 15)));
  const u = readUnlocks();
  const cur = u[key] && u[key].day === dayKey() ? u[key] : { until: 0, day: dayKey(), n: 0 };
  if (cur.n >= 3) throw new Error(`${app} 今天已经放行过 3 次了，今天不能再放了（这是代码定的上限）`);
  cur.until = Date.now() + m * 60_000;
  cur.n += 1;
  u[key] = cur;
  db.setSetting("app_unlocks", JSON.stringify(u));
  return `已放行 ${app} ${m} 分钟，到 ${fmtLocal(cur.until, tzNow())}（今天第 ${cur.n}/3 次）`;
}

// ---- 用时统计（靠快捷指令报的 app_open / app_close，约数）----
export function usedMinutesToday(app: string, now = Date.now()): number {
  const tz = tzNow();
  const evs = db.eventsSince(localDayStart(now, tz), 3000).filter((e) => (e.kind === "app_open" || e.kind === "app_close") && e.app && e.at <= now);
  const key = norm(app);
  let total = 0;
  let open: { app: string; at: number } | null = null;
  const endSession = (to: number) => { if (open && norm(open.app) === key) total += Math.min(to - open.at, 3 * 3600_000); open = null; };
  for (const e of evs) {
    if (e.kind === "app_open") { endSession(Math.min(e.at, (open?.at ?? e.at) + 30 * 60_000)); open = { app: e.app!, at: e.at }; }
    else if (open && norm(open.app) === norm(e.app!)) endSession(e.at);
  }
  if (open && norm((open as { app: string }).app) === key) total += Math.min(now - (open as { at: number }).at, 30 * 60_000); // 还开着：最多算 30 分钟
  return Math.round(total / 60_000);
}

// ---- 学习模式：「学习」专注模式一打开，就开始一段由服务器计时的学习时间，期间指定的 app 都锁着 ----
// 计时在服务器这边：她把专注模式关掉，锁不会跟着解开，只有到点或者找 Claude 放行才行。
interface StudyCfg { apps: string[]; minutes: number; focus: string[] }
const studyCfg = (): StudyCfg => { try { return { apps: [], minutes: 90, focus: ["学习", "study"], ...JSON.parse(db.getSetting("study_cfg") || "{}") }; } catch { return { apps: [], minutes: 90, focus: ["学习", "study"] }; } };
interface StudySession { start: number; until: number; end?: number; how?: "expired" | "manual"; offAt?: number } // offAt：她提前关掉专注模式的时间（锁不解开，但学习时长算到这里）
const readSessions = (): StudySession[] => { try { return JSON.parse(db.getSetting("study_sessions") || "[]"); } catch { return []; } };
const writeSessions = (s: StudySession[]) => db.setSetting("study_sessions", JSON.stringify(s.slice(-80)));
const activeSession = (now: number): StudySession | null => { const l = readSessions().at(-1); return l && !l.end && l.until > now ? l : null; };

function closeExpired(now: number): void {
  const ss = readSessions();
  const l = ss.at(-1);
  if (l && !l.end && l.until <= now) { l.end = l.until; l.how = "expired"; writeSessions(ss); }
}
export function startStudy(minutes?: number, now = Date.now()): StudySession {
  closeExpired(now);
  const cur = activeSession(now);
  if (cur) return cur; // 已经在学习中，不重复开
  const m = Math.max(10, Math.min(Math.round(minutes ?? studyCfg().minutes), 360));
  const s: StudySession = { start: now, until: now + m * 60_000 };
  writeSessions([...readSessions(), s]);
  return s;
}
// 专注模式事件：打开「学习」→ 开始计时；关掉 → 只记下她提前关了（锁不解开）
eventHooks.push((kind, _app, detail, at) => {
  const names = studyCfg().focus.map((x) => x.toLowerCase());
  const match = !!detail && names.some((n) => detail.toLowerCase().includes(n));
  if (kind === "focus_on" && match && studyCfg().apps.length) startStudy(undefined, at);
  if (kind === "focus_off") {
    const ss = readSessions();
    const l = ss.at(-1);
    if (l && !l.end && l.until > at && !l.offAt) { l.offAt = at; writeSessions(ss); db.addEvent("study_focus_off_early", null, `${Math.round((at - l.start) / 60_000)} 分钟`, at); } // 锁不解开，会话照常计时到点；只是学习时长算到她关掉的这一刻
  }
});

export function studyConfigure(apps: string[], minutes: number, focus: string[]): string {
  const a = (apps ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 15);
  if (!a.length) throw new Error("没写要锁哪些 app");
  const f = (focus ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 5);
  const m = Math.max(10, Math.min(Math.round(Number(minutes) || 90), 360));
  db.setSetting("study_cfg", JSON.stringify({ apps: a, minutes: m, focus: f.length ? f : ["学习", "study"] }));
  return `学习模式已设置：「${(f.length ? f : ["学习"]).join("」「")}」专注模式一打开，就锁 ${a.join("、")}，锁 ${m} 分钟（到点自动解开，关掉专注模式不会提前解开）。要生效，得有一个「专注模式 → 学习 → 打开时」的自动化，去访问 /api/events?kind=focus_on&detail=学习。`;
}
export function studyStartNow(minutes: number): string {
  if (!studyCfg().apps.length) throw new Error("还没设置要锁哪些 app，先用 study_mode_config");
  const s = startStudy(minutes);
  return `学习开始，到 ${fmtLocal(s.until, tzNow())}，期间 ${studyCfg().apps.join("、")} 锁着`;
}
export function studyEnd(now = Date.now()): string {
  const s = activeSession(now);
  if (!s) return "现在没有进行中的学习";
  const u = JSON.parse(db.getSetting("study_ends") || "{}");
  const today = new Date().toISOString().slice(0, 10);
  const n = u.day === today ? u.n : 0;
  if (n >= 2) throw new Error("今天已经提前结束过 2 次学习了，不能再提前结束（代码定的上限）");
  db.setSetting("study_ends", JSON.stringify({ day: today, n: n + 1 }));
  const ss = readSessions();
  const l = ss.at(-1)!;
  l.end = now; l.how = "manual"; writeSessions(ss);
  return `已提前结束学习（学了 ${Math.round((now - l.start) / 60_000)} 分钟），今天第 ${n + 1}/2 次`;
}
export function studyStatus(now = Date.now()): string {
  closeExpired(now);
  const c = studyCfg();
  const s = activeSession(now);
  return `学习模式：锁 ${c.apps.length ? c.apps.join("、") : "（还没设置）"}，每次 ${c.minutes} 分钟，触发的专注模式：${c.focus.join("、")}。${s ? `现在进行中，到 ${fmtLocal(s.until, tzNow())}。` : "现在没在学习。"}`;
}
export function studyStats(days: number, now = Date.now()): string {
  closeExpired(now);
  const d = Math.max(1, Math.min(Math.round(days) || 7, 30));
  const since = now - d * 86400_000;
  const ss = readSessions().filter((s) => s.start >= since);
  if (!ss.length) return `最近 ${d} 天没有学习记录`;
  const mins = (s: StudySession) => Math.round((Math.min(s.offAt ?? Infinity, s.end ?? Math.min(now, s.until)) - s.start) / 60_000);
  const byDay = new Map<string, number>();
  for (const s of ss) { const k = new Intl.DateTimeFormat("zh-CN", { timeZone: tzNow(), month: "numeric", day: "numeric" }).format(s.start); byDay.set(k, (byDay.get(k) ?? 0) + mins(s)); }
  const early = ss.filter((s) => s.how === "manual").length;
  const focusOff = db.eventsSince(since, 500).filter((e) => e.kind === "study_focus_off_early").length;
  return [`最近 ${d} 天：${ss.length} 次学习，共 ${ss.reduce((t, s) => t + mins(s), 0)} 分钟；其中 ${early} 次申请提前结束，${focusOff} 次提前关掉了专注模式（锁没有解开）。`, ...[...byDay].map(([k, v]) => `- ${k}：${v} 分钟`), "（学习时长按「学习时间开始到结束/到点」算，只是约数，不等于真的在学。）"].join("\n");
}

// 放行时不带 block 这个键（只回 {"allow":1}）：快捷指令里「取到的值」没有类型，If 只能选「有值/没值」，所以「有 block = 被拦」最好用
export type GateResult = { allow: 1 } | { block: 1; message: string; rule: number }

/** 被拦时给手机发一条通知：点它会打开主屏幕上的聊天网页 App（不是 Safari），并预填「我想开……因为」。同一个 app 两分钟内只发一次 */
function notifyBlocked(app: string, now: number): void {
  const k = "lock_push_" + norm(app);
  if (now - (Number(db.getSetting(k, "0")) || 0) < 120_000) return;
  db.setSetting(k, String(now));
  if (!db.listPushSubs().length) return;
  void sendPush({ title: "应用锁", body: `${app} 被锁着。真有事，点这里跟我说。`, url: `/?lock=${encodeURIComponent(app)}`, tag: "claude-lock" }).catch(() => {});
}

/** 她打开 app 时的判定。只做本地计算，必须快（快捷指令在等） */
export function gate(app: string, now = Date.now()): GateResult {
  db.purgeExpiredAppRules(now);
  const key = norm(app);
  if (!key) return { allow: 1 };
  const u = readUnlocks()[key];
  if (u && u.until > now) return { allow: 1 };
  closeExpired(now);
  const study = activeSession(now);
  if (study && studyCfg().apps.some((a) => norm(a) === key)) {
    db.addEvent("lock_block", app, "学习中", now);
    notifyBlocked(app, now);
    return { block: 1, rule: 0, message: `学习中，${app} 先锁着，到 ${fmtLocal(study.until, tzNow())}。真有事就去聊天里跟 Claude 说。` };
  }
  const tz = tzNow();
  const mins = localMinutes(now, tz);
  for (const r of db.listAppRules()) {
    if (norm(r.app) !== key) continue;
    let hit = "";
    if (r.kind === "window") {
      const a = toMin(r.start), b = toMin(r.end);
      if (a < b ? mins >= a && mins < b : mins >= a || mins < b) hit = `现在是 ${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}，${r.app} 在 ${r.start}–${r.end} 被锁着。`;
    } else {
      const used = usedMinutesToday(app, now);
      if (used >= r.limit_min) hit = `今天 ${r.app} 已经用了约 ${used} 分钟，上限是 ${r.limit_min} 分钟。`;
    }
    if (hit) {
      db.addEvent("lock_block", r.app, `#${r.id}`, now);
      notifyBlocked(r.app, now);
      return { block: 1, rule: r.id, message: `${hit}${r.note ? " " + r.note + "。" : ""}真有事就去聊天里跟 Claude 说。` };
    }
  }
  return { allow: 1 };
}
