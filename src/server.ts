import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import * as db from "./db.ts";
import { authEnabled, login, logout, requireLogin } from "./auth.ts";
import { buildHistory, buildSystem, maybeSummarize } from "./context.ts";
import { isImageName, readImage, saveImage } from "./uploads.ts";
import { DEFAULT_SYSTEM } from "./persona.ts";
import { wereadStatus } from "./weread.ts";
import { memosStatus } from "./memos.ts";
import { publicKey, rememberOrigin, sendPush } from "./push.ts";
import { checkDeviceToken, checkRawToken, deviceEnabled, recordEvent } from "./device.ts";
import { getProactive, heartbeat, startScheduler, updateProactive } from "./proactive.ts";
import { currentOrNew, generate, place, publicState, saveGame, type Difficulty } from "./sudoku.ts";
import { DEFAULT_MODEL, MODELS, describeError, findModel, streamChat } from "./claude.ts";

const app = new Hono();

// 访问日志：只记方法、路径（不含问号后面的参数，因为设备口令可能在那里）和状态码，不记请求头和内容
app.use("*", async (c, next) => {
  const p = c.req.path;
  const track = p.startsWith("/api/") || p === "/login";
  const t0 = Date.now();
  await next();
  if (track) console.log(`${c.req.method} ${p} ${c.res.status} ${Date.now() - t0}ms`);
});

app.use("*", secureHeaders());
// 每次都让浏览器回来问一遍服务器，保证登录检查不被缓存绕过
app.use("*", async (c, next) => {
  await next();
  if (/^\/(hero\.png|icon-)/.test(c.req.path)) c.header("Cache-Control", "public, max-age=604800");
  else if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-cache");
});

// 设了 APP_PASSWORD 就要先登录（放公网必须设）
app.get("/login", (c) => c.html(readFileSync("public/login.html", "utf8")));
app.post("/login", login);
app.use("*", requireLogin);
app.post("/logout", logout);
app.get("/api/session", (c) => c.json({ auth: authEnabled }));

// 前端依赖直接从 node_modules 提供，省掉构建步骤
app.get("/vendor/marked.js", serveStatic({ path: "node_modules/marked/lib/marked.umd.js" }));
app.get("/vendor/purify.js", serveStatic({ path: "node_modules/dompurify/dist/purify.min.js" }));

// ---- 数独 ----
app.get("/api/game/sudoku", (c) => c.json(publicState(currentOrNew())));

app.post("/api/game/sudoku/new", async (c) => {
  const { difficulty } = await c.req.json<{ difficulty?: string }>().catch(() => ({ difficulty: undefined }));
  if (difficulty !== "easy" && difficulty !== "medium" && difficulty !== "hard")
    return c.json({ error: "difficulty must be easy / medium / hard" }, 400);
  const g = generate(difficulty as Difficulty);
  saveGame(g);
  return c.json(publicState(g));
});

app.post("/api/game/sudoku/move", async (c) => {
  const { index, value } = await c.req.json<{ index?: number; value?: number }>();
  const g = currentOrNew();
  const err = place(g, Number(index), Number(value), "p");
  if (err) return c.json({ error: err }, 400);
  saveGame(g);
  return c.json(publicState(g));
});

// ---- 通知与主动消息 ----
app.get("/api/push/key", (c) => c.json({ key: publicKey() }));

app.post("/api/push/subscribe", async (c) => {
  const { subscription, tz } = await c.req.json<{ subscription?: { endpoint?: string; keys?: unknown }; tz?: string }>();
  if (!subscription?.endpoint?.startsWith("https://") || !subscription.keys) return c.json({ error: "订阅信息不对" }, 400);
  db.savePushSub({ endpoint: subscription.endpoint, ...subscription });
  rememberOrigin(c.req.header("x-forwarded-host") ?? c.req.header("host"));
  if (tz) updateProactive({ tz });
  return c.json({ ok: true });
});

app.post("/api/push/unsubscribe", async (c) => {
  const { endpoint } = await c.req.json<{ endpoint?: string }>();
  if (endpoint) db.removePushSub(endpoint);
  return c.json({ ok: true });
});

app.post("/api/push/test", async (c) => c.json(await sendPush({ title: "Claude", body: "通知已经通了。", url: "/" })));

app.get("/api/proactive", (c) => c.json({ ...getProactive(), subscriptions: db.listPushSubs().length }));

app.put("/api/proactive", async (c) => {
  const r = updateProactive(await c.req.json());
  return typeof r === "string" ? c.json({ error: r }, 400) : c.json(r);
});

// 设置页上的「现在试一条」：跳过所有限制，让 Claude 马上写一条
app.post("/api/proactive/run", async (c) => c.json(await heartbeat({ force: true })));

// ---- 设备事件：快捷指令用 DEVICE_TOKEN 上报（不走登录 cookie）----
// POST：口令可以放在 Authorization 请求头里，也可以放在网址的 token 参数里；kind/app/detail 同理，请求体里的优先
app.post("/api/events", async (c) => {
  const q = c.req.query();
  if (!checkDeviceToken(c.req.header("authorization")) && !checkRawToken(q.token)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => null);
  const err = recordEvent({ kind: q.kind, app: q.app, detail: q.detail, ...(body && typeof body === "object" ? body : {}) });
  return err ? c.json({ error: err }, 400) : c.json({ ok: true });
});

// 更简单的 GET 版本，给快捷指令用：口令放在网址的 token 参数里，不用设请求头和请求体。
// 例：/api/events?token=口令&kind=app_open&app=微信读书
app.get("/api/events", (c) => {
  if (!checkRawToken(c.req.query("token"))) return c.json({ error: "unauthorized" }, 401);
  const err = recordEvent({ kind: c.req.query("kind"), app: c.req.query("app"), detail: c.req.query("detail") });
  return err ? c.json({ error: err }, 400) : c.json({ ok: true });
});

app.get("/api/device/status", (c) => {
  const last = db.latestEvent();
  return c.json({ enabled: deviceEnabled, last: last ?? null });
});

app.get("/api/memory/status", async (c) => c.json(await memosStatus()));
app.get("/api/weread/status", async (c) => c.json(await wereadStatus()));

app.get("/api/models", (c) => c.json({ models: MODELS, default: DEFAULT_MODEL }));

const persona = () => db.getSetting("system_prompt") || DEFAULT_SYSTEM;

app.get("/api/settings", (c) => c.json({ system_prompt: persona() }));
app.put("/api/settings", async (c) => {
  const body = await c.req.json<{ system_prompt?: string }>();
  db.setSetting("system_prompt", String(body.system_prompt ?? ""));
  return c.json({ ok: true });
});

// ---- 唯一的一条对话 ----
const thread = () => db.mainConversation(DEFAULT_MODEL);

app.get("/api/thread", (c) => {
  const conv = thread();
  const before = Number(c.req.query("before")) || null;
  const limit = Math.min(Number(c.req.query("limit")) || 40, 100);
  return c.json({
    conversation: { id: conv.id, model: conv.model },
    ...db.messagePage(conv.id, before, limit),
  });
});

app.patch("/api/thread", async (c) => {
  const { model } = await c.req.json<{ model?: string }>();
  if (!model || !findModel(model)) return c.json({ error: "unknown model" }, 400);
  db.setModel(thread().id, model);
  return c.json({ ok: true });
});

// 界面上清空重来（数据库里旧记录还在，Memos 里的记忆不受影响）
app.post("/api/thread/reset", (c) => {
  db.createConversation(thread().model);
  return c.json({ ok: true });
});

// ---- 图片 ----
app.post("/api/upload", bodyLimit({ maxSize: 10 * 1024 * 1024, onError: (c) => c.json({ error: "图片太大" }, 413) }), async (c) => {
  const name = saveImage(Buffer.from(await c.req.arrayBuffer()));
  if (!name) return c.json({ error: "只支持 jpg / png / webp / gif" }, 400);
  return c.json({ id: name });
});

app.get("/uploads/:name", (c) => {
  const img = readImage(c.req.param("name"));
  if (!img) return c.notFound();
  return c.body(new Uint8Array(img.data), 200, {
    "Content-Type": img.mediaType,
    "Cache-Control": "private, max-age=31536000, immutable",
  });
});

// 发送一条消息，回复用 SSE 流式返回
app.post("/api/thread/chat", async (c) => {
  const conv = thread();
  const body = await c.req.json<{ content?: string; images?: string[] }>();
  const userText = String(body.content ?? "").trim();
  const images = (body.images ?? []).filter((n) => isImageName(n) && readImage(n)).slice(0, 4);
  if (!userText && !images.length) return c.json({ error: "empty message" }, 400);
  const model = findModel(conv.model) ?? MODELS[0];

  db.addMessage(conv.id, "user", userText, images);

  return streamSSE(c, async (sse) => {
    const abort = new AbortController();
    sse.onAbort(() => abort.abort());
    let text = "";
    try {
      // 摘要是后台更新的，这里重新读一次最新的
      const fresh = db.getConversation(conv.id)!;
      const result = await streamChat({
        model,
        system: await buildSystem(fresh),
        messages: buildHistory(fresh),
        signal: abort.signal,
        onText: (delta) => void sse.writeSSE({ event: "text", data: JSON.stringify(delta) }),
        onTool: (label, name) => {
          void sse.writeSSE({ event: "tool", data: JSON.stringify(label) });
          // 游戏状态可能被 Claude 改了，通知前端刷新棋盘
          if (name.startsWith("sudoku_")) void sse.writeSSE({ event: "game", data: "{}" });
        },
      });
      text = result.text;
      if (result.stopReason === "refusal")
        await sse.writeSSE({ event: "error", data: JSON.stringify("这条被安全策略拒绝了") });
      else if (result.stopReason === "max_tokens")
        await sse.writeSSE({ event: "error", data: JSON.stringify("回复被长度上限截断了") });
    } catch (err) {
      console.error(err);
      await sse.writeSSE({ event: "error", data: JSON.stringify(describeError(err)) });
    }
    if (text) db.addMessage(conv.id, "assistant", text);
    await sse.writeSSE({ event: "done", data: "{}" });
    void maybeSummarize(conv.id);
  });
});

app.use("*", serveStatic({ root: "public" }));

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, async () => {
  console.log(`listening on http://localhost:${port}`);
  startScheduler();
  console.log(`device events: ${deviceEnabled ? "ON" : "OFF (DEVICE_TOKEN not set)"}`);
  const s = await memosStatus();
  console.log(
    !s.enabled
      ? "memory: OFF (MEMOS_URL / MEMOS_TOKEN not set in the container)"
      : s.ok
        ? "memory: ON (Memos reachable)"
        : `memory: ERROR (${s.error})`,
  );
  const w = await wereadStatus();
  console.log(
    !w.enabled
      ? "weread: OFF (WEREAD_API_KEY not set in the container)"
      : w.ok
        ? "weread: ON (gateway reachable)"
        : `weread: ERROR (${w.error})`,
  );
});

// 收到格式不对的请求时（比如请求头里有非法字符），Node 会直接断开连接；记一笔，排查"连接中断"时有用
server.on("clientError", (err: NodeJS.ErrnoException) => console.error(`clientError: ${err.code ?? err.message}`));
