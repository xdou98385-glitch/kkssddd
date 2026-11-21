// 陪听模式：她在别的 app 里放歌（经 Last.fm 知道），Claude 在聊天里随口接一句，像一起听歌。
// 每次插话都要调一次 Claude，所以有限制：每小时最多几句、两句之间至少隔 4 分钟、安静时段不说、她刚发过消息不抢话、
// 一首歌至少听了半分钟才考虑说话，而且 Claude 自己可以选择 [skip]。
import * as db from "./db.ts";
import { DEFAULT_MODEL, MODELS, findModel, streamChat } from "./claude.ts";
import { buildHistory, buildSystem, stripToolMarks } from "./context.ts";
import { getProactive, inQuietHours } from "./proactive.ts";
import { musicEnabled, recentTracks } from "./music.ts";

export interface ListenSettings { enabled: boolean; maxPerHour: number }
const DEFAULTS: ListenSettings = { enabled: false, maxPerHour: 4 };

export function getListen(): ListenSettings {
  const raw = db.getSetting("listen");
  return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
}
export function updateListen(patch: Partial<ListenSettings>): ListenSettings | string {
  const s = getListen();
  if (patch.enabled !== undefined) s.enabled = Boolean(patch.enabled);
  if (patch.maxPerHour !== undefined) {
    const n = Number(patch.maxPerHour);
    if (!Number.isInteger(n) || n < 1 || n > 12) return "每小时句数要在 1 到 12 之间";
    s.maxPerHour = n;
  }
  db.setSetting("listen", JSON.stringify(s));
  return s;
}

const POLL_MS = 30_000;
const COOLDOWN_MS = 4 * 60_000;
let lastKey = ""; // 上一轮看到的正在放的歌
let commentedKey = ""; // 已经决定过要不要说话的那首（说了或 skip 了都算，避免同一首反复问）
let busy = false;
const sentAt: number[] = [];

function instruction(now: string, recent: string[]): string {
  return [
    "[系统消息，不是小月说的，别回应这条消息本身]",
    "你们正在一起听歌：她在自己的手机上放歌，你通过 Last.fm 知道她放到哪首了。",
    `现在在放：${now}`,
    recent.length ? `在这之前她放过：\n${recent.map((r) => "- " + r).join("\n")}` : "",
    "你可以接一句话，也可以什么都不说。",
    "- 只有真有话说才说：这首歌和她最近的状态、你们聊过的事、她之前常听的东西有关，或者你对这首歌本来就知道的一点点背景。别每首都说。",
    "- 一句，很短，像坐在旁边随口一句。不要自我介绍，不要说「我看到你在听」这种播报。",
    "- 你听不到音频，也看不到歌词。别编歌词，别描述你根本没听到的旋律或编曲；不确定的事就别说。",
    "- 不想说就只回复 [skip]。回复只能是要发给她的那句话本身（或 [skip]），不要加前后说明。",
  ].filter(Boolean).join("\n");
}

async function tick(): Promise<void> {
  const s = getListen();
  if (!s.enabled || !musicEnabled || busy) return;
  busy = true;
  try {
    const tracks = await recentTracks(6);
    const cur = tracks[0]?.nowPlaying ? tracks[0] : null;
    if (!cur) { lastKey = ""; commentedKey = ""; return; } // 没在放歌；下次再放同一首也算新的一次
    if (cur.key !== lastKey) { lastKey = cur.key; return; } // 刚换歌：等下一轮，确认不是随手切过去的
    if (cur.key === commentedKey) return;

    const now = Date.now();
    const pro = getProactive();
    const conv = db.mainConversation(DEFAULT_MODEL);
    const last = db.lastMessage(conv.id);
    while (sentAt.length && now - sentAt[0] > 3600_000) sentAt.shift();
    if (inQuietHours(pro, now)) return;
    if (sentAt.length >= s.maxPerHour) return;
    if (sentAt.length && now - sentAt.at(-1)! < COOLDOWN_MS) return;
    if (last?.role === "user" && now - last.created_at < 2 * 60_000) return; // 她刚说话，别抢
    if (last?.role === "assistant" && last.kind === "listen" && now - last.created_at < COOLDOWN_MS) return;

    commentedKey = cur.key;
    const fresh = db.getConversation(conv.id)!;
    const model = findModel(fresh.model) ?? MODELS[0];
    const result = await streamChat({
      model,
      system: await buildSystem(fresh),
      messages: [...buildHistory(fresh), { role: "user", content: instruction(cur.label, tracks.slice(1, 5).map((t) => t.label)) }],
      signal: AbortSignal.timeout(90_000),
      onText: () => {},
      onTool: () => {},
      effort: "low", // 只是随口一句
      tag: "listen",
    });
    const text = result.finalText.trim();
    if (!text || /^\[skip\]/i.test(text) || result.stopReason === "refusal") return;
    db.addMessage(conv.id, "assistant", stripToolMarks(text), [], "listen", result.toolsUsed);
    sentAt.push(Date.now());
  } catch (err) {
    console.error("listen:", err instanceof Error ? err.message : err);
  } finally {
    busy = false;
  }
}

export const __tick = tick; // 只给测试用
export function startListenScheduler(): void {
  setInterval(() => void tick(), POLL_MS).unref();
}
