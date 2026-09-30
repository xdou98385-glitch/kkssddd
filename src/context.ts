import type Anthropic from "@anthropic-ai/sdk";
import * as db from "./db.ts";
import { summarize } from "./claude.ts";
import { readImage } from "./uploads.ts";

// 上下文策略：摘要之后的消息原文都带着；超过 MAX_WINDOW 条时，把最早的压进摘要，只留 KEEP 条。
// 一次砍一大截而不是每轮滑动一条，这样前缀能稳定很多轮，提示词缓存才有用。
const MAX_WINDOW = 60;
const KEEP = 30;
// 只有最近这么多条消息里的图片会真的发给模型，更早的换成文字占位，省 token
const IMAGE_RECENT = 10;

type Content = Anthropic.Beta.BetaMessageParam["content"];

function toParam(m: db.Message, withImages: boolean): Anthropic.Beta.BetaMessageParam {
  if (!m.images.length) return { role: m.role, content: m.content };
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
