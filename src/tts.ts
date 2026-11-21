// 文字转语音（ElevenLabs）。按文本缓存到 data/tts/，同一段文字不会重复收费；每月有字符上限。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as db from "./db.ts";
import { translateForSpeech } from "./claude.ts";

import { cfg, onConfigChange } from "./config.ts";

const key = () => cfg("ELEVENLABS_API_KEY");
const voice = () => cfg("ELEVENLABS_VOICE_ID");
const model = process.env.TTS_MODEL || "eleven_flash_v2_5"; // Flash 每字符只算 0.5 额度；想要更好的音质换 eleven_multilingual_v2
const MAX_CHARS = Math.max(50, Number(process.env.TTS_MAX_CHARS || 400) || 400); // 单条最多念多少字
const MONTHLY_CHARS = Math.max(0, Number(process.env.TTS_MONTHLY_CHARS || 20000) || 20000); // 每月最多生成多少字

// 声音的"慢"和"表现力"。speed 0.7–1.2（越小越慢），stability 越低越有起伏，style 越高越夸张
const num = (v: string | undefined, d: number, lo: number, hi: number) => {
  const n = Number(v);
  return v && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const voiceSettings = {
  speed: num(process.env.TTS_SPEED, 0.85, 0.7, 1.2),
  stability: num(process.env.TTS_STABILITY, 0.35, 0, 1),
  similarity_boost: 0.75,
  style: num(process.env.TTS_STYLE, 0.3, 0, 1),
};

export interface Voice { model: string; settings: Record<string, unknown> }
export const chatVoice: Voice = { model, settings: voiceSettings };
// 电台节目的声线：用更有表现力的模型，稳定度适中、起伏更大，语速接近正常。可用 POD_* 环境变量调
export const podcastVoice: Voice = {
  model: process.env.TTS_PODCAST_MODEL || "eleven_multilingual_v2",
  settings: {
    speed: num(process.env.POD_SPEED, 0.95, 0.7, 1.2),
    stability: num(process.env.POD_STABILITY, 0.45, 0, 1),
    similarity_boost: 0.75,
    style: num(process.env.POD_STYLE, 0.4, 0, 1),
    use_speaker_boost: true,
  },
};
const callMe = process.env.TTS_CALL_ME || "Kay"; // 英文里怎么称呼她
const PROMPT_VERSION = "v4"; // 改了翻译提示词就加一，旧译文缓存自动作废

export let ttsEnabled = false; // 设置页改了配置会重新计算
const refresh = () => { ttsEnabled = Boolean(key() && voice()); };
onConfigChange(refresh);
refresh();

const dir = join(dirname(process.env.DB_PATH ?? "data/chat.db"), "tts");
mkdirSync(dir, { recursive: true });

export class TtsError extends Error {}

/** 清掉 markdown、代码、表情和系统记录，只留适合念出来的文字；太长就在句子边界截断 */
export function speakable(raw: string): string {
  let t = raw
    .replace(/\[系统记录：[^\]]*\]/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[#>\-*+\s]+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > MAX_CHARS) {
    const cut = t.slice(0, MAX_CHARS);
    const end = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"), cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
    t = end > MAX_CHARS * 0.5 ? cut.slice(0, end + 1) : cut;
  }
  return t;
}

// 念之前先翻成这种语言（她的声音是英文的）。TTS_TRANSLATE_TO=none 关掉
const target = process.env.TTS_TRANSLATE_TO || "English";
const translateOn = target.toLowerCase() !== "none";
const translations = new Map<string, Promise<string>>();

/** 要念的最终文字：清理后的原文，必要时翻译；译文缓存到磁盘，每条只翻一次 */
export async function speechText(raw: string): Promise<string> {
  const text = speakable(raw);
  if (!text || !translateOn) return text;
  if (!/[\u3400-\u9fff]/.test(text)) return text; // 已经是英文（比如通话里的回复），不用再翻
  const file = join(dir, createHash("sha256").update(`${PROMPT_VERSION}|${target}|${callMe}|${text}`).digest("hex").slice(0, 32) + ".txt");
  if (existsSync(file)) return readFileSync(file, "utf8");
  let job = translations.get(file);
  if (!job) {
    job = translateForSpeech(text, target, callMe)
      .then((t) => {
        if (!t) throw new TtsError("翻译失败");
        writeFileSync(file, t);
        console.log(`usage: tts-translate ${text.length} chars -> ${t.length} chars`);
        return t;
      })
      .finally(() => translations.delete(file));
    translations.set(file, job);
  }
  return job;
}

const month = () => new Date().toISOString().slice(0, 7);

function used(): number {
  try {
    const u = JSON.parse(db.getSetting("tts_usage") || "{}");
    return u.month === month() ? Number(u.chars) || 0 : 0;
  } catch { return 0; }
}
const addUsed = (n: number) => db.setSetting("tts_usage", JSON.stringify({ month: month(), chars: used() + n }));

export const ttsUsage = () => ({ used: used(), limit: MONTHLY_CHARS });

const inflight = new Map<string, Promise<Buffer>>();

/** 返回 mp3；缓存命中不花钱。ctx 是前后文，长文分段时用来让语气衔接 */
export async function synthesize(text: string, v: Voice = chatVoice, ctx: { previous?: string; next?: string } = {}): Promise<Buffer> {
  if (!ttsEnabled) throw new TtsError("还没配置语音");
  const name = createHash("sha256").update(`${v.model}|${voice()}|${JSON.stringify(v.settings)}|${text}`).digest("hex").slice(0, 32) + ".mp3";
  const file = join(dir, name);
  if (existsSync(file)) return readFileSync(file);
  const pending = inflight.get(name);
  if (pending) return pending;

  const job = (async () => {
    if (used() + text.length > MONTHLY_CHARS)
      throw new TtsError(`这个月的语音额度用完了（${used()}/${MONTHLY_CHARS} 字）`);
    const res = await fetch(
      `${process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io"}/v1/text-to-speech/${encodeURIComponent(voice())}?output_format=mp3_44100_64`,
      {
        method: "POST",
        headers: { "xi-api-key": key(), "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text,
          model_id: v.model,
          voice_settings: v.settings,
          ...(ctx.previous ? { previous_text: ctx.previous } : {}),
          ...(ctx.next ? { next_text: ctx.next } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      console.error(`tts: ElevenLabs ${res.status} ${body}`);
      throw new TtsError(res.status === 401 ? "语音 key 不对" : res.status === 429 ? "语音服务太忙或额度用完了" : `语音服务出错 ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(file, buf);
    addUsed(text.length);
    console.log(`usage: tts ${v.model} chars=${text.length} month_total=${used()}/${MONTHLY_CHARS}`);
    return buf;
  })().finally(() => inflight.delete(name));
  inflight.set(name, job);
  return job;
}

/** 把长文按段落切成一块一块（每块不超过 max 字），尽量在段落、再在句子处断开 */
export function chunkText(text: string, max = 900): string[] {
  const out: string[] = [];
  let cur = "";
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  for (const para of text.split(/\n{2,}/)) {
    const pieces = para.length <= max ? [para] : para.split(/(?<=[.!?。！？])\s+/);
    for (const piece of pieces) {
      if (cur && cur.length + piece.length + 2 > max) push();
      cur += (cur ? "\n\n" : "") + piece;
    }
  }
  push();
  return out;
}

/** 长文配音：分块合成再拼起来，每块带上前后文让语气接得上；整段结果也缓存 */
export async function synthesizeLong(text: string, v: Voice = podcastVoice): Promise<Buffer> {
  if (!ttsEnabled) throw new TtsError("还没配置语音");
  const whole = join(dir, "ep-" + createHash("sha256").update(`${v.model}|${voice()}|${JSON.stringify(v.settings)}|${text}`).digest("hex").slice(0, 32) + ".mp3");
  if (existsSync(whole)) return readFileSync(whole);
  if (used() + text.length > MONTHLY_CHARS)
    throw new TtsError(`这个月的语音额度不够做这一期了（已用 ${used()}/${MONTHLY_CHARS} 字，这期要约 ${text.length} 字）`);
  const chunks = chunkText(text);
  const bufs: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    bufs.push(await synthesize(chunks[i], v, { previous: chunks[i - 1]?.slice(-300), next: chunks[i + 1]?.slice(0, 300) }));
  }
  const all = Buffer.concat(bufs);
  writeFileSync(whole, all);
  return all;
}

// ---- ElevenLabs 账户的真实额度（不是我们自己记的字符数）----
const api = () => process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io";
let quotaCache: { at: number; left: number; limit: number; tier: string } | null = null;
onConfigChange(() => { quotaCache = null; });

/** 查账户：套餐、已用、总额。60 秒内重复查用缓存；查不到返回 null */
export async function elevenQuota(force = false): Promise<{ left: number; limit: number; used: number; tier: string } | null> {
  if (!ttsEnabled) return null;
  if (!force && quotaCache && Date.now() - quotaCache.at < 60_000) return { ...quotaCache, used: quotaCache.limit - quotaCache.left };
  try {
    const res = await fetch(`${api()}/v1/user/subscription`, { headers: { "xi-api-key": key() }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const d = (await res.json()) as { character_count?: number; character_limit?: number; tier?: string };
    if (typeof d.character_count !== "number" || typeof d.character_limit !== "number") return null;
    quotaCache = { at: Date.now(), left: Math.max(0, d.character_limit - d.character_count), limit: d.character_limit, tier: d.tier ?? "" };
    return { ...quotaCache, used: d.character_count };
  } catch { return null; }
}

/** 设置页「测试」用：key 对不对、Voice ID 存不存在、还剩多少额度 */
export async function voiceStatus(): Promise<{ enabled: boolean; ok?: boolean; error?: string; detail?: string }> {
  if (!ttsEnabled) return { enabled: false };
  try {
    const sub = await fetch(`${api()}/v1/user/subscription`, { headers: { "xi-api-key": key() }, signal: AbortSignal.timeout(8000) });
    if (sub.status === 401) return { enabled: true, ok: false, error: "API Key 不对" };
    if (!sub.ok) return { enabled: true, ok: false, error: `账户查询出错 ${sub.status}` };
    const v = await fetch(`${api()}/v1/voices/${encodeURIComponent(voice())}`, { headers: { "xi-api-key": key() }, signal: AbortSignal.timeout(8000) });
    if (v.status === 404 || v.status === 400 || v.status === 422) return { enabled: true, ok: false, error: "Voice ID 找不到，检查有没有复制全" };
    const q = await elevenQuota(true);
    return { enabled: true, ok: true, detail: q ? `套餐 ${q.tier || "未知"}，本月已用 ${q.used}/${q.limit} 额度，还剩 ${q.left}` : "连接正常" };
  } catch (err) {
    return { enabled: true, ok: false, error: (err as Error).message };
  }
}
