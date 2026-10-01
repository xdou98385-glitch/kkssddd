// 网页推送（Web Push）。VAPID 密钥第一次用时自动生成并存库，不用手动配置。
import webpush from "web-push";
import * as db from "./db.ts";

// VAPID 要求带一个「联系方式」（mailto: 或 https: 网址）。苹果的推送服务会校验它，
// 所以默认用站点自己的 https 地址（订阅时记下来）；也可以在 .env 里用 PUSH_CONTACT 指定。
function contact(): string {
  return process.env.PUSH_CONTACT || db.getSetting("public_origin") || "mailto:noreply@example.com";
}

/** 订阅时记下站点的公网地址，例如 https://xxx.ts.net（带端口或不像域名的不记） */
export function rememberOrigin(host: string | undefined): void {
  if (host && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(host)) db.setSetting("public_origin", `https://${host}`);
}

function vapid(): { publicKey: string; privateKey: string } {
  const raw = db.getSetting("vapid");
  if (raw) return JSON.parse(raw);
  const keys = webpush.generateVAPIDKeys();
  db.setSetting("vapid", JSON.stringify(keys));
  return keys;
}

export const publicKey = () => vapid().publicKey;

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

export interface PushResult {
  sent: number;
  removed: number;
  failed: number;
  errors: string[]; // 每个失败的原因（状态码 + 推送服务返回的说明），给设置页显示
}

/** 发给所有订阅的设备。订阅已失效（404/410）的会清掉，并且把原因记下来。 */
export async function sendPush(payload: PushPayload): Promise<PushResult> {
  const keys = vapid();
  webpush.setVapidDetails(contact(), keys.publicKey, keys.privateKey);
  const out: PushResult = { sent: 0, removed: 0, failed: 0, errors: [] };
  for (const sub of db.listPushSubs()) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600, urgency: "normal" });
      out.sent++;
    } catch (err) {
      const e = err as { statusCode?: number; body?: string; message?: string };
      const detail = `${e.statusCode ?? "?"} ${String(e.body || e.message || "").slice(0, 120)}`.trim();
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.removePushSub(sub.endpoint);
        out.removed++;
        out.errors.push(`订阅已失效，已清除（${detail}）`);
      } else {
        out.failed++;
        out.errors.push(detail);
      }
    }
  }
  console.log(`push: sent=${out.sent} removed=${out.removed} failed=${out.failed}${out.errors.length ? " errors=" + JSON.stringify(out.errors) : ""}`);
  return out;
}
