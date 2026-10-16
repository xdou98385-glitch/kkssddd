// 设备活动：iPhone 快捷指令（或别的设备）往 /api/events 汇报，Claude 通过 device_activity 工具读。
import { createHmac, timingSafeEqual } from "node:crypto";
import * as db from "./db.ts";

const token = process.env.DEVICE_TOKEN ?? "";
export const deviceEnabled = token !== "";

/** 校验 Authorization: Bearer <DEVICE_TOKEN>，用定长比较防止通过耗时猜 token */
export function checkRawToken(given: string | undefined): boolean {
  if (!deviceEnabled || !given) return false;
  const a = createHmac("sha256", "dev").update(given.trim()).digest();
  const b = createHmac("sha256", "dev").update(token).digest();
  return timingSafeEqual(a, b);
}

export function checkDeviceToken(header: string | undefined): boolean {
  return header?.startsWith("Bearer ") ? checkRawToken(header.slice(7)) : false;
}

/** 她的时区：聊天时由浏览器上报；没有就用主动消息设置里的，再没有用 UTC */
export function userTz(): string {
  const saved = db.getSetting("tz");
  if (saved) return saved;
  try {
    return JSON.parse(db.getSetting("proactive") || "{}").tz || "UTC";
  } catch {
    return "UTC";
  }
}

const clip =(v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

/** 校验并记录一条事件；不合法返回原因 */
export function recordEvent(body: any): string | null {
  const kind = clip(body?.kind, 40);
  if (!kind || !/^[a-z0-9_:-]+$/i.test(kind)) return "kind 必填，只能是字母数字和 _ - :";
  const at = Number(body?.at);
  db.addEvent(kind, clip(body?.app, 60), clip(body?.detail, 200), Number.isFinite(at) && at > 1e12 ? at : undefined);
  return null;
}

const KIND_TEXT: Record<string, (e: db.DeviceEvent) => string> = {
  app_open: (e) => `打开 ${e.app ?? "某个 app"}`,
  app_close: (e) => `离开 ${e.app ?? "某个 app"}`,
  focus_on: (e) => `开启专注模式${e.detail ? `（${e.detail}）` : ""}`,
  focus_off: () => "关闭专注模式",
  charging_on: (e) => `开始充电${e.detail ? `（电量 ${e.detail}）` : ""}`,
  charging_off: (e) => `拔掉充电器${e.detail ? `（电量 ${e.detail}）` : ""}`,
  wake: () => "起床（关了闹钟）",
  arrive: (e) => `到达 ${e.app ?? e.detail ?? "某地"}`,
  leave: (e) => `离开 ${e.app ?? e.detail ?? "某地"}`,
};

function fmtTime(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
}

/** 最近 minutes 分钟的设备活动，写成给 Claude 读的文字 */
export function activitySummary(minutes: number, tz: string, now = Date.now()): string {
  const events = db.eventsSince(now - minutes * 60_000);
  if (!events.length) return `最近 ${minutes} 分钟没有收到任何设备事件（可能她没碰手机，也可能快捷指令没触发）。`;
  const lines = events.map((e) => `${fmtTime(e.at, tz)} ${(KIND_TEXT[e.kind] ?? (() => `${e.kind}${e.app ? " " + e.app : ""}${e.detail ? " " + e.detail : ""}`))(e)}`);
  const opens = new Map<string, number>();
  for (const e of events) if (e.kind === "app_open" && e.app) opens.set(e.app, (opens.get(e.app) ?? 0) + 1);
  const top = [...opens].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, n]) => `${a} ${n} 次`);
  const last = events.at(-1)!;
  const ago = Math.round((now - last.at) / 60_000);
  return [
    `最近 ${minutes} 分钟的设备事件（本地时间 ${tz}，从早到晚）：`,
    ...lines,
    top.length ? `打开次数：${top.join("、")}` : "",
    `最后一条事件是 ${ago} 分钟前。注意：只有她设置了快捷指令的那几类事件会被记录，没记录不代表没用手机。`,
  ].filter(Boolean).join("\n");
}
