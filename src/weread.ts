// 微信读书（Agent Gateway）。接口约定：POST 一个 JSON，api_name 指定接口，业务参数平铺在同一层，必须带 skill_version。
// 凭据只从环境变量 WEREAD_API_KEY 读，不要写进代码或提交到 git。
const key = process.env.WEREAD_API_KEY ?? "";
const url = process.env.WEREAD_URL ?? "https://i.weread.qq.com/api/agent/gateway";
const SKILL_VERSION = "1.0.4";

export const wereadEnabled = key !== "";

// 只开放只读接口
export const WEREAD_APIS = [
  "/store/search",
  "/book/info",
  "/book/chapterinfo",
  "/book/getprogress",
  "/shelf/sync",
  "/readdata/detail",
  "/user/notebooks",
  "/book/bookmarklist",
  "/review/list/mine",
  "/review/list",
  "/review/single",
  "/book/bestbookmarks",
  "/book/underlines",
  "/book/readreviews",
  "/book/recommend",
  "/book/similar",
  "/discover/interact/type3",
  "/_list", // 网关返回全部接口及参数定义
] as const;

const MAX_CHARS = 24000; // 回包太长会撑爆上下文，截断并提示

async function gateway(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401) throw new Error("微信读书鉴权失败（401）：WEREAD_API_KEY 无效或已过期，需要重新获取");
  if (!res.ok) throw new Error(`微信读书 HTTP ${res.status}`);
  const data = await res.json();
  // 网关要求升级时立刻停下，把指引原样交给调用方
  if (data?.upgrade_info) throw new Error(`微信读书网关要求升级：${data.upgrade_info.message ?? JSON.stringify(data.upgrade_info)}`);
  if (data?.errcode && data.errcode !== 0) throw new Error(`微信读书返回错误 errcode=${data.errcode} ${data.errmsg ?? ""}`.trim());
  return data;
}

export async function callWeRead(apiName: string, params: Record<string, unknown>): Promise<string> {
  if (!(WEREAD_APIS as readonly string[]).includes(apiName)) throw new Error(`不支持的接口 ${apiName}`);
  // 这三个字段由网关/代码控制，不允许调用方覆盖（身份由 token 绑定，别手动传 vid）
  const { api_name: _a, skill_version: _v, vid: _vid, ...rest } = params;
  const data = await gateway({ ...rest, api_name: apiName, skill_version: SKILL_VERSION });
  const text = JSON.stringify(data);
  return text.length > MAX_CHARS
    ? text.slice(0, MAX_CHARS) + `\n…[回包太长，已截断，共 ${text.length} 字符。需要的话缩小范围或用分页参数再查]`
    : text;
}

/** 连接状态：没配置 / 已连接 / 连不上（带原因） */
export async function wereadStatus(): Promise<{ enabled: boolean; ok?: boolean; error?: string }> {
  if (!wereadEnabled) return { enabled: false };
  try {
    await gateway({ api_name: "/_list", skill_version: SKILL_VERSION });
    return { enabled: true, ok: true };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    return { enabled: true, ok: false, error: e.message + (e.cause ? ` (${e.cause.code ?? e.cause.message})` : "") };
  }
}
