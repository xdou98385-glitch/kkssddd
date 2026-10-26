import type Anthropic from "@anthropic-ai/sdk";
import { coreMemories, memosEnabled, saveMemo, searchMemos } from "./memos.ts";
import { WEREAD_APIS, callWeRead, wereadEnabled } from "./weread.ts";
import { activitySummary, deviceEnabled, userTz } from "./device.ts";
import * as db from "./db.ts";
import { douyinEnabled, dyFeed, dyLikes, dySearch, dyWork } from "./douyin.ts";
import { XhsError, xhsEnabled, xhsFeed, xhsMe, xhsNote, xhsSearch } from "./xhs.ts";
import { describeShares } from "./share.ts";
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
        "把一条值得长期记住的事存进小月的 Memos。一条一件事，开头带日期，用你自己的口气、第一人称写两到四句：先准确说发生了什么，再写你的感受、观察或下次该怎么做，看法要标明是你的。比如「2026-09-30 小月说她不喜欢香菜，我记下了。她说的时候皱着鼻子，我觉得是真的很讨厌，以后点菜别替她加。」",
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

// ---- 微信读书：只给一个工具，接口表和字段规则放在提示词里（见 persona.ts 的 WEREAD_GUIDE）----
const WEREAD_LABELS: Record<string, string> = {
  "/store/search": "搜书", "/book/info": "看书的详情", "/book/chapterinfo": "看章节目录", "/book/getprogress": "看阅读进度",
  "/shelf/sync": "翻书架", "/readdata/detail": "看阅读统计", "/user/notebooks": "翻笔记", "/book/bookmarklist": "翻划线",
  "/review/list/mine": "翻她的想法", "/review/list": "看点评", "/review/single": "看一条想法", "/book/bestbookmarks": "看热门划线",
  "/book/underlines": "看划线热度", "/book/readreviews": "看划线下的想法", "/book/recommend": "看推荐", "/book/similar": "找相似的书",
  "/discover/interact/type3": "看朋友在读什么", "/_list": "看接口说明",
};

const wereadTool: Tool = {
  def: {
    name: "weread",
    description:
      "查询小月的微信读书（只读）：搜书、书架、阅读进度、阅读统计、划线、想法、推荐等。api_name 选接口，params_json 是一个 JSON 对象字符串，业务参数平铺，如 {\"keyword\":\"三体\",\"scope\":10}；没有参数传 {}。",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        api_name: { type: "string", enum: [...WEREAD_APIS] },
        params_json: { type: "string", description: "JSON 对象字符串，参数平铺，没有参数就传 {}" },
      },
      required: ["api_name", "params_json"],
      additionalProperties: false,
    },
  },
  run: async (input) => {
    let params: unknown;
    try {
      params = JSON.parse(String(input.params_json || "{}"));
    } catch {
      throw new Error("params_json 不是合法的 JSON 对象字符串");
    }
    if (typeof params !== "object" || params === null || Array.isArray(params))
      throw new Error("params_json 必须是 JSON 对象");
    return callWeRead(String(input.api_name), params as Record<string, unknown>);
  },
  label: (input) => {
    let extra = "";
    try {
      const p = JSON.parse(String(input.params_json || "{}"));
      if (typeof p.keyword === "string") extra = `：${p.keyword}`;
    } catch { /* 标签只是提示，解析失败就不带参数 */ }
    return `${WEREAD_LABELS[input.api_name] ?? "查微信读书"}${extra}`;
  },
};

// ---- 设备活动：快捷指令上报的事件 ----
const deviceTool: Tool = {
  def: {
    name: "device_activity",
    description:
      "查看小月手机最近的活动（她用快捷指令上报的：打开了哪些 app、专注模式、充电、起床等）。minutes 是往回看多久。只有事件没有时长，没记录不代表没用手机。",
    strict: true,
    input_schema: {
      type: "object",
      properties: { minutes: { type: "integer", enum: [30, 60, 180, 720, 1440] } },
      required: ["minutes"],
      additionalProperties: false,
    },
  },
  run: async (input) => activitySummary(Number(input.minutes) || 180, userTz()),
  label: () => "看了眼她手机最近在干嘛",
};

// ---- 抖音（只读）----
const douyinTools: Tool[] = [
  {
    def: {
      name: "dy_feed",
      description: "看她抖音首页的推荐流（她的账号推给她的东西），返回十几条的文字、作者、数据和 id。想知道她最近在刷什么时用。",
      strict: true,
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    run: () => dyFeed(),
    label: () => "刷了眼抖音推荐",
  },
  {
    def: {
      name: "dy_search",
      description: "在抖音搜索视频，返回文字、作者、数据和 id。",
      strict: true,
      input_schema: { type: "object", properties: { keyword: { type: "string", description: "搜索关键词" } }, required: ["keyword"], additionalProperties: false },
    },
    run: (input) => dySearch(String(input.keyword ?? "")),
    label: (input) => `搜了抖音：${input.keyword}`,
  },
  {
    def: {
      name: "dy_work",
      description: "读一条抖音的文字、数据和热门评论（看不到画面）。ref 可以是 dy_feed / dy_search 返回的 id，也可以是她分享的抖音链接。",
      strict: true,
      input_schema: { type: "object", properties: { ref: { type: "string", description: "作品 id 或抖音链接" } }, required: ["ref"], additionalProperties: false },
    },
    run: (input) => dyWork(String(input.ref ?? "")),
    label: () => "点开了一条抖音",
  },
  {
    def: {
      name: "dy_likes",
      description: "看她最近在抖音点过赞的视频。想知道她喜欢什么类型的内容时用。",
      strict: true,
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    run: () => dyLikes(),
    label: () => "翻了翻她点赞过的抖音",
  },
];

// ---- 小红书（只读）----
const xhsTools: Tool[] = [
  {
    def: {
      name: "xhs_search",
      description: "在小红书搜索笔记，返回标题、作者、点赞等和每条的 feed_id、xsec_token。她想看小红书上关于某个话题的内容、攻略、评价时用。",
      strict: true,
      input_schema: { type: "object", properties: { keyword: { type: "string", description: "搜索关键词" } }, required: ["keyword"], additionalProperties: false },
    },
    run: (input) => xhsSearch(String(input.keyword ?? "")),
    label: (input) => `搜了小红书：${input.keyword}`,
  },
  {
    def: {
      name: "xhs_feed",
      description: "看她小红书首页的推荐流（她的账号推给她的东西），返回前十几条。想知道她最近被推了什么、在刷什么时用。",
      strict: true,
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    run: () => xhsFeed(),
    label: () => "刷了眼小红书推荐",
  },
  {
    def: {
      name: "xhs_note",
      description: "打开一条小红书笔记，读正文和热门评论。feed_id 和 xsec_token 必须原样用 xhs_search 或 xhs_feed 返回的，别自己编。",
      strict: true,
      input_schema: {
        type: "object",
        properties: { feed_id: { type: "string" }, xsec_token: { type: "string" } },
        required: ["feed_id", "xsec_token"],
        additionalProperties: false,
      },
    },
    run: (input) => xhsNote(String(input.feed_id ?? ""), String(input.xsec_token ?? "")),
    label: () => "点开了一条小红书笔记",
  },
  {
    def: {
      name: "xhs_me",
      description: "看她自己的小红书主页：昵称、简介、关注粉丝数和她发过的笔记。",
      strict: true,
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
    run: () => xhsMe(),
    label: () => "看了眼她的小红书主页",
  },
];

// ---- 她分享给你的东西 ----
const shareTool: Tool = {
  def: {
    name: "shared_items",
    description: "看她最近用快捷指令从抖音、小红书、B站等 app 分享给你的内容（标题、简介、她分享时的文字、链接）。她说「刚分享给你的」「我发你的那个视频」「我最近刷的」时用。",
    strict: true,
    input_schema: { type: "object", properties: { count: { type: "integer", enum: [3, 8, 20] } }, required: ["count"], additionalProperties: false },
  },
  run: async (input) => describeShares(Number(input.count) || 8) || "她最近没有分享过东西。",
  label: () => "翻了翻她分享的东西",
};

// ---- 时钟：此刻的准确时间 ----
const clockTool: Tool = {
  def: {
    name: "get_time",
    description:
      "查看此刻的准确日期和时间（她的本地时间）。她每条消息开头已经带了发送时间，一般不用调；需要精确到现在、或想算距离她上次发言过了多久时才用。",
    strict: true,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  run: async () => {
    const now = Date.now();
    const tz = userTz();
    const text = new Intl.DateTimeFormat("zh-CN", { timeZone: tz, dateStyle: "full", timeStyle: "medium", hourCycle: "h23" }).format(now);
    const last = db.latestMessage();
    const gap = last?.role === "user" ? `；她最后一条消息是 ${Math.round((now - last.created_at) / 60_000)} 分钟前发的` : "";
    return `现在是 ${text}（${tz}）${gap}`;
  },
  label: () => "看了眼时间",
};

// 每次取都重新算：设置页里开关某个连接后，立刻生效
export const getTools = (): Tool[] => [
  clockTool,
  ...gameTools,
  ...(memosEnabled ? memoryTools : []),
  ...(wereadEnabled ? [wereadTool] : []),
  ...(deviceEnabled ? [deviceTool, shareTool] : []),
  ...(xhsEnabled ? xhsTools : []),
  ...(douyinEnabled ? douyinTools : []),
];
export const findTool = (name: string) => getTools().find((t) => t.def.name === name);

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
