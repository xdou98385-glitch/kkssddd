// 文字转语音（ElevenLabs）。按文本缓存到 data/tts/，同一段文字不会重复收费；每月有字符上限。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as db from "./db.ts";
import { translateForSpeech } from "./claude.ts";

const key = process.env.ELEVENLABS_API_KEY || "";
const voice = process.env.ELEVENLABS_VOICE_ID || "";
const model = process.env.TTS_MODEL || "eleven_flash_v2_5"; // Flash 每字符只算 0.5 额度；想要更好的音质换 eleven_multilingual_v2
const MAX_CHARS = Math.max(50, Number(process.env.TTS_MAX_CHARS || 400) || 400); // 单条最多念多少字
const MONTHLY_CHARS = Math.max(0, Number(process.env.TTS_MONTHLY_CHARS || 20000) || 20000); // 每月最多生成多少字

export const ttsEnabled = Boolean(key && voice);

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
  const file = join(dir, createHash("sha256").update(`${target}|${text}`).digest("hex").slice(0, 32) + ".txt");
  if (existsSync(file)) return readFileSync(file, "utf8");
  let job = translations.get(file);
  if (!job) {
    job = translateForSpeech(text, target)
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

/** 返回 mp3；缓存命中不花钱 */
export async function synthesize(text: string): Promise<Buffer> {
  if (!ttsEnabled) throw new TtsError("还没配置语音");
  const name = createHash("sha256").update(`${model}|${voice}|${text}`).digest("hex").slice(0, 32) + ".mp3";
  const file = join(dir, name);
  if (existsSync(file)) return readFileSync(file);
  const pending = inflight.get(name);
  if (pending) return pending;

  const job = (async () => {
    if (used() + text.length > MONTHLY_CHARS)
      throw new TtsError(`这个月的语音额度用完了（${used()}/${MONTHLY_CHARS} 字）`);
    const res = await fetch(
      `${process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io"}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_64`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: model }),
        signal: AbortSignal.timeout(45_000),
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
    console.log(`usage: tts ${model} chars=${text.length} month_total=${used()}/${MONTHLY_CHARS}`);
    return buf;
  })().finally(() => inflight.delete(name));
  inflight.set(name, job);
  return job;
}
