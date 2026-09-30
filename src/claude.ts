import Anthropic from "@anthropic-ai/sdk";

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

/** 流式调用 Claude。onText 每来一段文字就调用一次；返回完整文本和结束原因。 */
export async function streamChat(opts: {
  model: ModelOption;
  system: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  onText: (delta: string) => void;
}): Promise<{ text: string; stopReason: string | null }> {
  const { model } = opts;
  const stream = client.beta.messages.stream(
    {
      model: model.id,
      max_tokens: 64000,
      // 自动缓存最后一个可缓存块：长对话每轮只需为新增内容付全价
      cache_control: { type: "ephemeral" },
      ...(opts.system ? { system: opts.system } : {}),
      ...(model.effort ? { output_config: { effort: model.effort } } : {}),
      // 被安全分类器拒绝时，服务器自动换模型重跑
      ...(model.fallback
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
      messages: opts.messages,
    },
    { signal: opts.signal },
  );

  let text = "";
  stream.on("text", (delta) => {
    text += delta;
    opts.onText(delta);
  });

  try {
    const final = await stream.finalMessage();
    return { text, stopReason: final.stop_reason };
  } catch (err) {
    // 用户中途停止：保留已生成的部分
    if (opts.signal.aborted) return { text, stopReason: "aborted" };
    throw err;
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "API key 无效或没设置（检查 ANTHROPIC_API_KEY）";
  if (err instanceof Anthropic.RateLimitError) return "触发限流了，稍后再试";
  if (err instanceof Anthropic.APIError) return `API 错误 ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
