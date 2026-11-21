// 联网搜索：用 Anthropic 官方的 web_search 服务端工具，搜索由 Anthropic 那边执行，我们只负责开关和计数。
// 按搜索次数另外计费（每千次约 10 美元），所以默认关、每天有上限。使用前要在 Anthropic Console 的组织设置里允许 Web search。
import type Anthropic from "@anthropic-ai/sdk";
import * as db from "./db.ts";
import { cfg } from "./config.ts";
import { userTz } from "./device.ts";

const DAILY = Math.max(1, Number(process.env.WEB_SEARCH_DAILY || 30) || 30);
const PER_TURN = 3; // 一次回复里最多搜几次
const day = () => new Date().toISOString().slice(0, 10);

export const webSearchSwitch = () => cfg("WEB_SEARCH").trim().toLowerCase() === "on";
export function usedToday(): number {
  try { const u = JSON.parse(db.getSetting("web_search_usage") || "{}"); return u.day === day() ? Number(u.n) || 0 : 0; } catch { return 0; }
}
export const noteWebSearches = (n: number) => db.setSetting("web_search_usage", JSON.stringify({ day: day(), n: usedToday() + n }));
export const webSearchLimit = () => DAILY;

/** 开着且今天没用完才给 Claude 这个工具；用完了它就知道自己查不了网页（不会硬编） */
export function webSearchTools(): Anthropic.Beta.BetaToolUnion[] {
  if (!webSearchSwitch() || usedToday() >= DAILY) return [];
  return [{ type: "web_search_20250305", name: "web_search", max_uses: PER_TURN, user_location: { type: "approximate", timezone: userTz() === "UTC" ? "Asia/Tokyo" : userTz() } }];
}
