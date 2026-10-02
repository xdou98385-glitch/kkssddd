import Anthropic from "@anthropic-ai/sdk";
import { findTool, tools } from "./tools.ts";

// key 从环境变量 ANTHROPIC_API_KEY 读取，不要写进代码
const client = new Anthropic();

export interface ModelOption {
  id: string;
  label: string;
  effort?: "low" | "medium" | "high";
  fallback: boolean;
}

// 下拉框里显示的模型。Haiku 4.5 不支持 effort 参数，所以没设。
export const MODELS: ModelOption[] = [
  // effort 低了它会少调工具、凭印象回答；陪伴场景里"真的去查"比省 token 重要，所以日常模型用 high
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5（日常）", effort: "high", fallback: true },
  // 4.6 不在服务器端 fallback 的支持名单里；没传 thinking 参数时它不思考，单价比 5.5 高 50%
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6（旧语气）", effort: "high", fallback: false },
  { id: "claude-opus-5-5", label: "Opus 5.5（难题）", effort: "medium", fallback: true },
  { id: "claude-haiku-4-5", label: "Haiku 4.5（便宜快）", fallback: false },
];
export const DEFAULT_MODEL = MODELS[0].id;

export function findModel(id: string): ModelOption | undefined {
  return MODELS.find((m) => m.id === id);
}

const MAX_TOOL_TURNS = 8;

/** 流式调用 Claude，遇到工具调用就执行并继续，直到它给出最终回复。 */
export async function streamChat(opts: {
  model: ModelOption;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  signal: AbortSignal;
  onText: (delta: string) => void;
  onTool: (label: string, name: string) => void;
  effort?: "low" | "medium" | "high"; // 覆盖模型默认的 effort（模型本身不支持 effort 时无效）
  tag?: string; // 日志里标注这次调用是干嘛的（chat / proactive）
}): Promise<{ text: string; finalText: string; stopReason: string | null; toolsUsed: string[] }> {
  const { model } = opts;
  const messages: Anthropic.Beta.BetaMessageParam[] = [...opts.messages];
  const toolsUsed: string[] = []; // 真正成功执行过的工具（由代码记录，不是模型自己说的）
  let text = ""; // 整条回复，含调用工具前说的话
  let finalText = ""; // 只有最后一轮（真正的回复）
  let stopReason: string | null = null;
  const used = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; // 本次所有轮次的 token 合计
  const logUsage = () =>
    console.log(`usage: ${opts.tag ?? "chat"} ${model.id} in=${used.input} cache_read=${used.cacheRead} cache_write=${used.cacheWrite} out=${used.output}`);

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const stream = client.beta.messages.stream(
      {
        model: model.id,
        max_tokens: 64000,
        // 自动缓存最后一个可缓存块：长对话每轮只需为新增内容付全价
        cache_control: { type: "ephemeral" },
        ...(opts.system ? { system: opts.system } : {}),
        ...(model.effort ? { output_config: { effort: opts.effort ?? model.effort } } : {}),
        ...(tools.length ? { tools: tools.map((t) => t.def) } : {}),
        // 被安全分类器拒绝时，服务器自动换模型重跑
        ...(model.fallback
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
        messages,
      },
      { signal: opts.signal },
    );

    // 同一条回复里前后两轮文字之间补个空行
    let separate = text !== "";
    finalText = "";
    stream.on("text", (delta) => {
      if (separate) {
        separate = false;
        text += "\n\n";
        opts.onText("\n\n");
      }
      text += delta;
      finalText += delta;
      opts.onText(delta);
    });

    let final: Anthropic.Beta.BetaMessage;
    try {
      final = await stream.finalMessage();
    } catch (err) {
      // 用户中途停止：保留已生成的部分
      if (opts.signal.aborted) { logUsage(); return { text, finalText, stopReason: "aborted", toolsUsed }; }
      throw err;
    }
    used.input += final.usage.input_tokens;
    used.output += final.usage.output_tokens;
    used.cacheRead += final.usage.cache_read_input_tokens ?? 0;
    used.cacheWrite += final.usage.cache_creation_input_tokens ?? 0;
    stopReason = final.stop_reason;
    if (stopReason !== "tool_use") break;

    // 原样带回 assistant 的完整内容（含 thinking 块），再附上工具结果
    messages.push({ role: "assistant", content: final.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const block of final.content) {
      if (block.type !== "tool_use") continue;
      const tool = findTool(block.name);
      try {
        if (!tool) throw new Error(`未知工具 ${block.name}`);
        opts.onTool(tool.label(block.input), block.name);
        const output = await tool.run(block.input);
        if (!toolsUsed.includes(block.name)) toolsUsed.push(block.name);
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      } catch (err) {
        console.error(`tool ${block.name}:`, err);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: err instanceof Error ? err.message : String(err),
        });
      }
    }
    messages.push({ role: "user", content: results });
  }
  logUsage();
  return { text, finalText, stopReason, toolsUsed };
}

const SUMMARY_MODEL = "claude-haiku-4-5";

/** 把旧摘要和新增的对话合并成一份新摘要（用便宜的 Haiku） */
export async function summarize(previous: string, transcript: string): Promise<string> {
  const res = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 2000,
    system:
      "你负责给一段长期对话维护「滚动摘要」。把旧摘要和新增对话合并成一份更新后的摘要，用中文，不超过 800 字。" +
      "保留：发生过的事实、约定和承诺、她的近况和情绪、还没聊完的话题、两人之间的称呼和梗。" +
      "不要评论，不要写成对话，只输出摘要正文。",
    messages: [
      {
        role: "user",
        content: `旧摘要：\n${previous || "（无）"}\n\n新增对话：\n${transcript}`,
      },
    ],
  });
  return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "API key 无效或没设置（检查 ANTHROPIC_API_KEY）";
  if (err instanceof Anthropic.RateLimitError) return "触发限流了，稍后再试";
  if (err instanceof Anthropic.APIError) return `API 错误 ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
