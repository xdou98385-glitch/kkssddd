import type Anthropic from "@anthropic-ai/sdk";
import { coreMemories, memosEnabled, saveMemo, searchMemos } from "./memos.ts";

export interface Tool {
  def: Anthropic.Beta.BetaTool;
  run(input: any): Promise<string>;
  /** 显示在聊天界面里的一行小提示 */
  label(input: any): string;
}

const memoryTools: Tool[] = [
  {
    def: {
      name: "search_memories",
      description:
        "在小月的 Memos 笔记里按关键词搜索记忆。返回匹配的笔记，带日期。查询词用 1-3 个关键词，用空格分隔，比如「咖啡 偏好」。",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "关键词，空格分隔" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    run: (input) => searchMemos(String(input.query ?? "")),
    label: (input) => `翻记忆：${input.query}`,
  },
  {
    def: {
      name: "save_memory",
      description:
        "把一条值得长期记住的事存进小月的 Memos。一条一件事，写成带日期的第三人称事实，比如「2026-09-30 小月说她不喜欢香菜」。",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          content: { type: "string", description: "要记住的内容" },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
    run: (input) => saveMemo(String(input.content ?? "")),
    label: (input) => `记下了：${input.content}`,
  },
];

export const tools: Tool[] = memosEnabled ? memoryTools : [];
export const findTool = (name: string) => tools.find((t) => t.def.name === name);

/** 每次对话开头注入的核心记忆（Memos 里带 #core 标签的笔记），拉不到就当没有 */
export async function coreMemoryBlock(): Promise<string> {
  if (!memosEnabled) return "";
  try {
    const core = await coreMemories();
    return core ? `小月的核心记忆：\n${core}` : "";
  } catch (err) {
    console.error("core memories:", err);
    return "";
  }
}
