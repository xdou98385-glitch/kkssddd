// 微信读书（Agent Gateway）。接口约定：POST 一个 JSON，api_name 指定接口，业务参数平铺在同一层，必须带 skill_version。
// 凭据只从环境变量 WEREAD_API_KEY 读，不要写进代码或提交到 git。
import { cfg, onConfigChange } from "./config.ts";
const key = () => cfg("WEREAD_API_KEY");
const url = process.env.WEREAD_URL ?? "https://i.weread.qq.com/api/agent/gateway";
// 跟官方 Tencent/WeChatReading 的 skills/SKILL.md 里的 version 保持一致（2026-11-17 起是 1.0.6）。网关靠它判断要不要给「有新版」的提示
const SKILL_VERSION = "1.0.6";

export let wereadEnabled = false; // 设置页改了配置会重新计算
const refresh = () => { wereadEnabled = key() !== ""; };
onConfigChange(refresh);
refresh();

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

let upgradeNotice = ""; // 最近一次网关给的升级提示（没有就是空），设置页的连接状态里显示
let lastNoticeLog = 0;
const MAX_CHARS = 24000; // 回包太长会撑爆上下文，截断并提示

async function gateway(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401) throw new Error("微信读书鉴权失败（401）：WEREAD_API_KEY 无效或已过期，需要重新获取");
  if (!res.ok) throw new Error(`微信读书 HTTP ${res.status}`);
  const data = await res.json();
  if (data?.errcode && data.errcode !== 0) throw new Error(`微信读书返回错误 errcode=${data.errcode} ${data.errmsg ?? ""}`.trim());
  // 官方 2026-11-17 起把 upgrade_info 改成「不阻塞」的升级提示：同一个回包里的业务数据照常可用，不要停下、不要重试。
  // 以前我们看到它就直接报错、把数据也丢了，导致一直读不到书。现在：数据照给，附一句话让 Claude 简短告诉她就行。
  if (data?.upgrade_info) {
    const msg = String(data.upgrade_info.message ?? JSON.stringify(data.upgrade_info)).slice(0, 300);
    upgradeNotice = msg;
    if (Date.now() - lastNoticeLog > 3600_000) { lastNoticeLog = Date.now(); console.log(`weread: 网关提示有新版 skill（不影响使用，当前发送的版本 ${SKILL_VERSION}）：${msg}`); }
    return { ...data, _系统提示: "微信读书网关提示有新版本（不影响这次结果）。请用本次回包里的数据完成她的请求，不要重试；可以在回答最后用一句话告诉她「读书那边有个新版本提示，不影响用」，不要反复提。" };
  }
  upgradeNotice = "";
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
export async function wereadStatus(): Promise<{ enabled: boolean; ok?: boolean; error?: string; detail?: string }> {
  if (!wereadEnabled) return { enabled: false };
  try {
    await gateway({ api_name: "/_list", skill_version: SKILL_VERSION });
    return { enabled: true, ok: true, ...(upgradeNotice ? { detail: "网关提示有新版本，不影响使用：" + upgradeNotice.slice(0, 80) } : {}) };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    return { enabled: true, ok: false, error: e.message + (e.cause ? ` (${e.cause.code ?? e.cause.message})` : "") };
  }
}
