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
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5（日常）", effort: "medium", fallback: true },
  { id: "claude-opus-5-5", label: "Opus 5.5（难题）", effort: "medium", fallback: true },
  { id: "claude-haiku-4-5", label: "Haiku 4.5（便宜快）", fallback: false },
];
export const DEFAULT_MODEL = MODELS[0].id;

export function findModel(id: string): ModelOption | undefined {
  return MODELS.find((m) => m.id === id);
}

export type ChatMessage = { role: "user" | "assistant"; content: string };

const MAX_TOOL_TURNS = 8;

/** 流式调用 Claude，遇到工具调用就执行并继续，直到它给出最终回复。 */
export async function streamChat(opts: {
  model: ModelOption;
  system: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  onText: (delta: string) => void;
  onTool: (label: string) => void;
}): Promise<{ text: string; stopReason: string | null }> {
  const { model } = opts;
  const messages: Anthropic.Beta.BetaMessageParam[] = [...opts.messages];
  let text = "";
  let stopReason: string | null = null;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const stream = client.beta.messages.stream(
      {
        model: model.id,
        max_tokens: 64000,
        // 自动缓存最后一个可缓存块：长对话每轮只需为新增内容付全价
        cache_control: { type: "ephemeral" },
        ...(opts.system ? { system: opts.system } : {}),
        ...(model.effort ? { output_config: { effort: model.effort } } : {}),
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
    stream.on("text", (delta) => {
      if (separate) {
        separate = false;
        text += "\n\n";
        opts.onText("\n\n");
      }
      text += delta;
      opts.onText(delta);
    });

    let final: Anthropic.Beta.BetaMessage;
    try {
      final = await stream.finalMessage();
    } catch (err) {
      // 用户中途停止：保留已生成的部分
      if (opts.signal.aborted) return { text, stopReason: "aborted" };
      throw err;
    }
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
        opts.onTool(tool.label(block.input));
        results.push({ type: "tool_result", tool_use_id: block.id, content: await tool.run(block.input) });
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
  return { text, stopReason };
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "API key 无效或没设置（检查 ANTHROPIC_API_KEY）";
  if (err instanceof Anthropic.RateLimitError) return "触发限流了，稍后再试";
  if (err instanceof Anthropic.APIError) return `API 错误 ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
