// 电台节目：她点「来一期」，Claude 照着最近聊的事写一期（中文稿 + 同内容的英语口语稿 + 标题），
// 英语稿分段配音。节目独立存放（episodes 表），不进聊天记录；写稿和配音在后台跑，前端轮询状态。
import * as db from "./db.ts";
import { DEFAULT_MODEL, MODELS, findModel, streamChat, translateForSpeech } from "./claude.ts";
import { buildHistory, buildSystem, stripToolMarks } from "./context.ts";
import { userTz } from "./device.ts";
import { podcastVoice, synthesizeLong, TtsError } from "./tts.ts";

let running = false;

function instruction(topic: string, recentTitles: string[]): string {
  const now = new Intl.DateTimeFormat("zh-CN", { timeZone: userTz(), dateStyle: "full", timeStyle: "short", hourCycle: "h23" }).format(Date.now());
  return [
    "[系统消息，不是小月说的，别回应这条消息本身]",
    `现在是 ${now}。小月点了「来一期」，想听你给她录一期电台节目。`,
    "- 长度：中文稿 600 到 900 字，分成 4 到 6 段，段与段之间空一行。像深夜电台里一个人慢慢讲，有开头、有展开、有收尾，别像发言稿，也别像总结。",
    "- 语气就是你平时对她的样子：松弛、懒、带点毒舌，但要有起伏：有的地方轻快，有的地方认真，有的地方停一下。别一个调子到底。",
    topic ? `- 她想听的主题：${topic}。围绕它讲，但保持你自己的口气。` : "- 没指定主题：接着你们最近聊的事，或者你自己此刻冒出来的念头、一个小观察，讲一个完整的片段。",
    "- 只能讲你确实知道的：对话里出现过的事，或者常识。别编造她手机上的动态、她读的书这类要查才知道的信息，想用就先调工具。",
    recentTitles.length ? `- 之前几期的标题，这次别重复主题：${recentTitles.join("、")}` : "",
    "- 直接开讲，不要「欢迎收听」之类的开场白，不要自我介绍，正文里不要标题、列表、表情和 markdown。",
    "- 输出格式必须严格如下，除了这四个标签不要有任何别的内容：",
    "<title>中文标题，4 到 12 个字，有点意思，别写「第几期」</title>",
    "<title_en>English title, 2 to 6 words</title_en>",
    "<zh>中文正文</zh>",
    "<en>同一内容的英语口语版</en>",
    "- 英语版的要求：不是逐句直译，而是把同一段话用英语重新讲一遍，像真的有人在对 Kay 说话。句子长短错落，用逗号、破折号和省略号安排停顿，偶尔来一句很短的，让节奏有起伏；声音是松的、暖的，别压着嗓子，也别播音腔。平时叫她 Kay，只有很正经的地方才叫 Kaylia。不要任何方括号标签。篇幅和中文版相当（约 450 到 700 个英文单词），段落也和中文版一一对应，段与段之间空一行。",
  ].filter(Boolean).join("\n");
}

const tag = (s: string, name: string) => s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1].trim() ?? "";

async function runEpisode(id: number, topic: string): Promise<void> {
  try {
    const conv = db.mainConversation(DEFAULT_MODEL);
    const fresh = db.getConversation(conv.id)!;
    const model = findModel(fresh.model) ?? MODELS[0];
    const recent = db.listEpisodes(6).filter((e) => e.id !== id && e.title).map((e) => e.title);
    const result = await streamChat({
      model,
      system: await buildSystem(fresh),
      messages: [...buildHistory(fresh), { role: "user", content: instruction(topic, recent) }],
      signal: AbortSignal.timeout(240_000),
      onText: () => {},
      onTool: () => {},
      effort: "medium",
      tag: "podcast",
    });
    if (result.stopReason === "refusal") throw new Error("这次没写出来，再试一次");
    const out = stripToolMarks(result.finalText);
    const zh = tag(out, "zh");
    let en = tag(out, "en");
    if (!zh) throw new Error("稿子格式不对，再试一次");
    if (!en) en = await translateForSpeech(zh, "English", process.env.TTS_CALL_ME || "Kay"); // 它漏写了英文稿：退回去翻译中文稿
    db.updateEpisode(id, { title: tag(out, "title") || "无题", title_en: tag(out, "title_en"), zh, en, status: "voicing" });
    await synthesizeLong(en, podcastVoice);
    db.updateEpisode(id, { status: "ready" });
  } catch (err) {
    console.error("podcast:", err);
    db.updateEpisode(id, { status: "failed", error: err instanceof TtsError || err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
  }
}

/** 开一期：立刻返回节目 id，后台去写稿、配音 */
export function startPodcast(topic: string): { id: number } | { error: string } {
  if (running) return { error: "上一期还在做" };
  running = true;
  const t = topic.trim().slice(0, 100);
  const id = db.createEpisode(t);
  void runEpisode(id, t);
  return { id };
}
