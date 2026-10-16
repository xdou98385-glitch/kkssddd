// 通话：她说话 → 语音识别（ElevenLabs Scribe）→ Claude 用英语短句回 → 语音合成。回复和她的话都存进聊天（kind=call）。
import * as db from "./db.ts";
import { DEFAULT_MODEL, MODELS, findModel, streamChat } from "./claude.ts";
import { buildHistory, buildSystem, stripToolMarks } from "./context.ts";
import { CALL_GUIDE } from "./persona.ts";
import { speechText, synthesize, ttsEnabled, TtsError } from "./tts.ts";

const key = process.env.ELEVENLABS_API_KEY || "";
const sttModel = process.env.CALL_STT_MODEL || "scribe_v1";
const MONTHLY_MIN = Math.max(0, Number(process.env.CALL_MONTHLY_MINUTES || 30) || 30); // 每月最多识别多少分钟她说的话
export const MAX_CALL_MIN = Math.max(1, Number(process.env.CALL_MAX_MINUTES || 10) || 10); // 单次通话最长多少分钟

export const callEnabled = ttsEnabled;

const month = () => new Date().toISOString().slice(0, 7);
function usedSeconds(): number {
  try {
    const u = JSON.parse(db.getSetting("call_usage") || "{}");
    return u.month === month() ? Number(u.seconds) || 0 : 0;
  } catch { return 0; }
}
const addSeconds = (s: number) => db.setSetting("call_usage", JSON.stringify({ month: month(), seconds: usedSeconds() + s }));

export class CallError extends Error {}

const EXT: Record<string, string> = { "audio/mp4": "mp4", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3" };

/** 语音转文字。durationMs 由前端报告，用来记月度用量 */
export async function transcribe(audio: Buffer, mime: string, durationMs: number): Promise<string> {
  const base = (mime || "").split(";")[0].trim().toLowerCase();
  const ext = EXT[base];
  if (!ext) throw new CallError("不支持的录音格式");
  const secs = Math.min(60, Math.max(1, Math.round(durationMs / 1000) || 1));
  if (usedSeconds() + secs > MONTHLY_MIN * 60) throw new CallError(`这个月的通话额度用完了（${Math.round(usedSeconds() / 60)}/${MONTHLY_MIN} 分钟）`);

  const send = async (model: string) => {
    const fd = new FormData();
    fd.append("model_id", model);
    fd.append("tag_audio_events", "false");
    fd.append("file", new Blob([new Uint8Array(audio)], { type: base }), `turn.${ext}`);
    return fetch(`${process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io"}/v1/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": key },
      body: fd,
      signal: AbortSignal.timeout(30_000),
    });
  };
  let res = await send(sttModel);
  // 模型名不被接受（400/422）时换另一个版本再试一次
  if (res.status === 400 || res.status === 422) res = await send(sttModel === "scribe_v2" ? "scribe_v1" : "scribe_v2");
  if (!res.ok) {
    console.error(`call: stt ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    throw new CallError(res.status === 401 ? "语音 key 不对" : res.status === 429 ? "语音服务太忙或额度用完了" : `语音识别出错 ${res.status}`);
  }
  addSeconds(secs);
  const data = (await res.json()) as { text?: string };
  console.log(`usage: stt ${sttModel} secs=${secs} month_total=${Math.round(usedSeconds())}s/${MONTHLY_MIN * 60}s`);
  return (data.text ?? "").trim();
}

let running = false;

export interface CallResult {
  heard?: string; // 识别出的她的话
  reply?: string;
  id?: number; // 回复的消息 id，前端据此取音频
  audioError?: string;
}

/** 处理一轮：有 text 就先记下她的话；hello=true 表示她刚接通，由它先开口 */
export async function callTurn(opts: { text?: string; hello?: boolean }): Promise<CallResult> {
  if (running) throw new CallError("上一句还在处理");
  running = true;
  try {
    const conv = db.mainConversation(DEFAULT_MODEL);
    if (opts.text) db.addMessage(conv.id, "user", opts.text, [], "call");
    const fresh = db.getConversation(conv.id)!;
    const model = findModel(fresh.model) ?? MODELS[0];
    const messages = buildHistory(fresh);
    if (opts.hello)
      messages.push({ role: "user", content: "[系统消息，不是小月说的]\n她刚接起通话。你先开口，一句话打个招呼，可以结合现在的时间，别问太多。" });
    const result = await streamChat({
      model,
      system: (await buildSystem(fresh)) + "\n\n" + CALL_GUIDE,
      messages,
      signal: AbortSignal.timeout(60_000),
      onText: () => {},
      onTool: () => {},
      effort: opts.hello ? "low" : "medium",
      tag: "call",
    });
    const reply = stripToolMarks(result.finalText.trim());
    if (!reply || result.stopReason === "refusal") throw new CallError("这句没接上，再说一次");
    const id = db.addMessage(conv.id, "assistant", reply, [], "call", result.toolsUsed);
    const out: CallResult = { heard: opts.text, reply, id };
    try {
      await synthesize(await speechText(reply)); // 先生成好，前端取音频时就是缓存命中
    } catch (err) {
      out.audioError = err instanceof TtsError ? err.message : "语音生成失败";
      if (!(err instanceof TtsError)) console.error("call tts:", err);
    }
    return out;
  } finally {
    running = false;
  }
}
