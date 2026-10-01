// 网页推送（Web Push）。VAPID 密钥第一次用时自动生成并存库，不用手动配置。
import webpush from "web-push";
import * as db from "./db.ts";

// 推送服务要求有个联系方式；随便填一个 mailto 即可，想填自己的邮箱就设 PUSH_CONTACT
const contact = process.env.PUSH_CONTACT || "mailto:noreply@example.com"; // 用 ||：.env 里留空也走默认值

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

/** 发给所有订阅的设备。订阅已失效（404/410）的会顺手清掉。 */
export async function sendPush(payload: PushPayload): Promise<{ sent: number; removed: number; failed: number }> {
  const keys = vapid();
  webpush.setVapidDetails(contact, keys.publicKey, keys.privateKey);
  const out = { sent: 0, removed: 0, failed: 0 };
  for (const sub of db.listPushSubs()) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 6 * 3600, urgency: "normal" });
      out.sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        db.removePushSub(sub.endpoint);
        out.removed++;
      } else {
        console.error("push failed:", status, (err as Error).message);
        out.failed++;
      }
    }
  }
  return out;
}
