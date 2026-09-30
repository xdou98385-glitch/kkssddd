import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import { getSetting, setSetting } from "./db.ts";

const COOKIE = "session";
const SESSION_DAYS = 30;

// 没设 APP_PASSWORD 就不启用登录（只适合放在私网里）
export const password = process.env.APP_PASSWORD ?? "";
export const authEnabled = password.length > 0;

// 签名密钥：随机生成并存库，重启不会掉线；改密码会让所有旧登录失效
function secret(): string {
  let s = getSetting("session_secret");
  if (!s) {
    s = randomBytes(32).toString("hex");
    setSetting("session_secret", s);
  }
  return s + password;
}

const sign = (payload: string) =>
  createHmac("sha256", secret()).update(payload).digest("base64url");

function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function makeToken(): string {
  const exp = String(Date.now() + SESSION_DAYS * 86400_000);
  return `${exp}.${sign(exp)}`;
}

function validToken(token: string | undefined): boolean {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !safeEqual(sig, sign(exp))) return false;
  return Number(exp) > Date.now();
}

// ---- 防暴力猜密码：单个 IP 连错 5 次锁 15 分钟；全站一小时连错 40 次也锁 15 分钟 ----
const LOCK_MS = 15 * 60_000;
const perIp = new Map<string, { fails: number; lockedUntil: number }>();
let global = { fails: 0, windowStart: Date.now(), lockedUntil: 0 };

function clientIp(c: Context): string {
  // 反向代理（Tailscale）会把真实 IP 追加在 X-Forwarded-For 末尾；取最后一项，前面的可能是客户端伪造的
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",").at(-1)!.trim();
  return getConnInfo(c).remote.address ?? "unknown";
}

function lockedFor(ip: string): number {
  const now = Date.now();
  const until = Math.max(perIp.get(ip)?.lockedUntil ?? 0, global.lockedUntil);
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

function recordFail(ip: string): void {
  const now = Date.now();
  const e = perIp.get(ip) ?? { fails: 0, lockedUntil: 0 };
  e.fails += 1;
  if (e.fails >= 5) { e.lockedUntil = now + LOCK_MS; e.fails = 0; }
  perIp.set(ip, e);
  if (now - global.windowStart > 3600_000) global = { fails: 0, windowStart: now, lockedUntil: global.lockedUntil };
  global.fails += 1;
  if (global.fails >= 40) global = { fails: 0, windowStart: now, lockedUntil: now + LOCK_MS };
}

// 不需要登录就能访问的路径（登录页本身 + 图标/清单，iOS 添加到主屏幕时会不带 cookie 去取）
const PUBLIC = new Set(["/login", "/login.html", "/manifest.webmanifest", "/icon.svg", "/icon-180.png", "/icon-192.png", "/icon-512.png"]);

export const requireLogin: MiddlewareHandler = async (c, next) => {
  if (!authEnabled || PUBLIC.has(c.req.path) || validToken(getCookie(c, COOKIE))) return next();
  if (c.req.path.startsWith("/api/")) return c.json({ error: "unauthorized" }, 401);
  return c.redirect("/login");
};

const isHttps = (c: Context) =>
  c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";

export async function login(c: Context) {
  const ip = clientIp(c);
  const wait = lockedFor(ip);
  if (wait) return c.json({ error: `失败次数太多，请 ${Math.ceil(wait / 60)} 分钟后再试` }, 429);
  const body = await c.req.json<{ password?: string }>().catch(() => ({ password: "" }));
  if (!safeEqual(String(body.password ?? ""), password)) {
    recordFail(ip);
    return c.json({ error: "密码不对" }, 401);
  }
  perIp.delete(ip);
  setCookie(c, COOKIE, makeToken(), {
    httpOnly: true,
    sameSite: "Lax",
    secure: isHttps(c),
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
  return c.json({ ok: true });
}

export function logout(c: Context) {
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
}
