import type Anthropic from "@anthropic-ai/sdk";
import * as db from "./db.ts";
import { summarize } from "./claude.ts";
import { readImage } from "./uploads.ts";
import { DEFAULT_SYSTEM, DEVICE_GUIDE, GAME_GUIDE, HONESTY_GUIDE, MEMORY_GUIDE, WEREAD_GUIDE } from "./persona.ts";
import { coreMemoryBlock } from "./tools.ts";
import { memosEnabled } from "./memos.ts";
import { wereadEnabled } from "./weread.ts";
import { deviceEnabled } from "./device.ts";

/** 系统提示词：人设 + 各功能的使用说明 + 核心记忆 + 更早对话的摘要。聊天和主动消息共用。 */
export async function buildSystem(conv: db.Conversation): Promise<string> {
  return [
    db.getSetting("system_prompt") || DEFAULT_SYSTEM,
    HONESTY_GUIDE,
    GAME_GUIDE,
    memosEnabled ? MEMORY_GUIDE : "",
    wereadEnabled ? WEREAD_GUIDE : "",
    deviceEnabled ? DEVICE_GUIDE : "",
    await coreMemoryBlock(),
    conv.summary ? `此前对话的摘要（更早的内容已不在上下文里）：\n${conv.summary}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// 上下文策略：摘要之后的消息原文都带着；超过 MAX_WINDOW 条时，把最早的压进摘要，只留 KEEP 条。
// 一次砍一大截而不是每轮滑动一条，这样前缀能稳定很多轮，提示词缓存才有用。
const MAX_WINDOW = 60;
const KEEP = 30;
// 只有最近这么多条消息里的图片会真的发给模型，更早的换成文字占位，省 token
const IMAGE_RECENT = 10;

type Content = Anthropic.Beta.BetaMessageParam["content"];

/** 助手的回复后面附上系统记录的真实工具调用，让它在回看历史时分得清哪些说法有依据 */
export const TOOL_MARK = (tools: string[]) => `[系统记录：这条回复调用了工具 ${tools.join("、")}]`;
/** 模型自己写出来的这种记录一律去掉，防止伪造 */
export const stripToolMarks = (text: string) => text.replace(/\[系统记录[^\]]*\]/g, "").trim();

function toParam(m: db.Message, withImages: boolean): Anthropic.Beta.BetaMessageParam {
  if (!m.images.length) {
    const marked = m.role === "assistant" && m.tools.length ? `${m.content}\n\n${TOOL_MARK(m.tools)}` : m.content;
    return { role: m.role, content: marked };
  }
  const blocks: Exclude<Content, string> = [];
  if (withImages) {
    for (const name of m.images) {
      const img = readImage(name);
      if (!img) continue;
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType as "image/jpeg", data: img.data.toString("base64") },
      });
    }
  }
  const note = withImages ? "" : `[${m.images.length} 张图片，已省略] `;
  const text = note + m.content;
  if (text.trim()) blocks.push({ type: "text", text });
  return { role: m.role, content: blocks.length ? blocks : "[图片]" };
}

export function buildHistory(conv: db.Conversation): Anthropic.Beta.BetaMessageParam[] {
  const win = db.windowMessages(conv.id, conv.summarized_upto);
  const firstUser = win.findIndex((m) => m.role === "user");
  const usable = firstUser < 0 ? [] : win.slice(firstUser); // API 要求第一条是 user
  return usable.map((m, i) => toParam(m, i >= usable.length - IMAGE_RECENT));
}

const running = new Set<string>();

/** 回复完成后在后台检查要不要压缩旧消息；失败不影响聊天，下次再试 */
export async function maybeSummarize(convId: string): Promise<void> {
  if (running.has(convId)) return;
  const conv = db.getConversation(convId);
  if (!conv) return;
  const win = db.windowMessages(conv.id, conv.summarized_upto);
  if (win.length <= MAX_WINDOW) return;

  // 保留的部分必须从 user 消息开始
  let cut = win.length - KEEP;
  while (cut < win.length && win[cut].role !== "user") cut++;
  if (cut <= 0 || cut >= win.length) return;
  const old = win.slice(0, cut);

  running.add(convId);
  try {
    const transcript = old
      .map((m) => `${m.role === "user" ? "她" : "你"}：${m.images.length ? "[图片] " : ""}${m.content}`)
      .join("\n");
    const summary = await summarize(conv.summary, transcript);
    if (summary) db.setSummary(conv.id, summary, old.at(-1)!.id);
  } catch (err) {
    console.error("summarize failed:", err);
  } finally {
    running.delete(convId);
  }
}
