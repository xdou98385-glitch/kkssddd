import type Anthropic from "@anthropic-ai/sdk";
import { coreMemories, memosEnabled, saveMemo, searchMemos } from "./memos.ts";
import { cellName, currentOrNew, hintText, parseCell, place, saveGame, viewText } from "./sudoku.ts";

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

// ---- 数独：Claude 看棋盘、给提示、替她落子 ----
const gameTools: Tool[] = [
  {
    def: {
      name: "sudoku_view",
      description:
        "查看小月当前的数独棋盘：盘面、空格数、有冲突的格子、和正确答案不一致的格子。她问局面、说卡住了、让你看看或陪她玩时，先调用它。",
      strict: true,
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    run: async () => viewText(currentOrNew()),
    label: () => "看了眼棋盘",
  },
  {
    def: {
      name: "sudoku_hint",
      description:
        "算出下一步的提示：会指出填错的格子，或者一个能用基础技巧推出的格子（含技巧名、位置、数字）。结果是给你看的，怎么对她说由你决定，默认别直接报答案。",
      strict: true,
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    run: async () => hintText(currentOrNew()),
    label: () => "想了个提示",
  },
  {
    def: {
      name: "sudoku_place",
      description:
        "替小月在棋盘上落一个数字。只有她明确让你来下的时候才用。cell 用 r行c列 的写法，比如 r3c4；value 是 1-9。",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          cell: { type: "string", description: "格子，格式 r3c4（第 3 行第 4 列）" },
          value: { type: "integer", enum: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
        },
        required: ["cell", "value"],
        additionalProperties: false,
      },
    },
    run: async (input) => {
      const g = currentOrNew();
      const i = parseCell(String(input.cell ?? ""));
      if (i === null) throw new Error("格子格式不对，要写成 r3c4 这种");
      const err = place(g, i, Number(input.value), "c");
      if (err) throw new Error(err);
      saveGame(g);
      const warn = g.cells[i] !== g.solution[i] ? "（注意：这个数字和正确答案不一致）" : "";
      return `已在 ${cellName(i)} 落下 ${input.value}${warn}。${g.solvedAt ? "这盘完成了！" : ""}`;
    },
    label: (input) => `落子：${input.cell} = ${input.value}`,
  },
];

export const tools: Tool[] = [...gameTools, ...(memosEnabled ? memoryTools : [])];
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
