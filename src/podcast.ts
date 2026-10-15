// 微播客：她点一下，Claude 照着最近聊的事写一小段中文独白，存进聊天（kind=podcast），再由喇叭按钮翻成英语念出来。
import * as db from "./db.ts";
import { DEFAULT_MODEL, MODELS, findModel, streamChat } from "./claude.ts";
import { buildHistory, buildSystem, stripToolMarks } from "./context.ts";
import { userTz } from "./device.ts";

let running = false;

function instruction(topic: string): string {
  const now = new Intl.DateTimeFormat("zh-CN", { timeZone: userTz(), dateStyle: "full", timeStyle: "short", hourCycle: "h23" }).format(Date.now());
  return [
    "[系统消息，不是小月说的，别回应这条消息本身]",
    `现在是 ${now}。小月点了「来一期」，想听你给她录一小段微播客。`,
    "- 一段 150 到 250 字的中文独白，像深夜电台里一个人慢慢讲。语气就是你平时对她的样子：松弛、懒、带点毒舌，慢一点，多停顿。",
    topic ? `- 她想听的主题：${topic}。围绕它讲，但保持你自己的口气。` : "- 没指定主题：接着你们最近聊的事，或者你自己此刻冒出来的念头、一个小观察，讲一个完整的小片段。",
    "- 只能讲你确实知道的：对话里出现过的事，或者常识。别编造她手机上的动态、她读的书这类要查才知道的信息，想用就先调工具。",
    "- 直接开讲，不要「欢迎收听」之类的开场白，不要自我介绍，不要标题、列表、表情和 markdown。结尾自然收住就行，不用提问。",
    "- 你的回复只能是独白本身，不要加任何前后说明。",
  ].join("\n");
}

export type PodcastResult = { id: number } | { error: string };

export async function makePodcast(topic: string): Promise<PodcastResult> {
  if (running) return { error: "上一期还在写" };
  running = true;
  try {
    const conv = db.mainConversation(DEFAULT_MODEL);
    const fresh = db.getConversation(conv.id)!;
    const model = findModel(fresh.model) ?? MODELS[0];
    const result = await streamChat({
      model,
      system: await buildSystem(fresh),
      messages: [...buildHistory(fresh), { role: "user", content: instruction(topic.trim().slice(0, 100)) }],
      signal: AbortSignal.timeout(120_000),
      onText: () => {},
      onTool: () => {},
      tag: "podcast",
    });
    const text = stripToolMarks(result.finalText.trim());
    if (!text || result.stopReason === "refusal") return { error: "这次没写出来，再试一次" };
    return { id: db.addMessage(conv.id, "assistant", text, [], "podcast", result.toolsUsed) };
  } catch (err) {
    console.error("podcast:", err);
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    running = false;
  }
}
