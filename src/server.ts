import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import * as db from "./db.ts";
import { authEnabled, login, logout, requireLogin } from "./auth.ts";
import { buildHistory, maybeSummarize } from "./context.ts";
import { isImageName, readImage, saveImage } from "./uploads.ts";
import { DEFAULT_SYSTEM, GAME_GUIDE, MEMORY_GUIDE } from "./persona.ts";
import { coreMemoryBlock } from "./tools.ts";
import { memosEnabled, memosStatus } from "./memos.ts";
import { currentOrNew, generate, place, publicState, saveGame, type Difficulty } from "./sudoku.ts";
import { DEFAULT_MODEL, MODELS, describeError, findModel, streamChat } from "./claude.ts";

const app = new Hono();

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

app.get("/api/memory/status", async (c) => c.json(await memosStatus()));

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
      const system = [
        persona(),
        GAME_GUIDE,
        memosEnabled ? MEMORY_GUIDE : "",
        await coreMemoryBlock(),
        fresh.summary ? `此前对话的摘要（更早的内容已不在上下文里）：\n${fresh.summary}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const result = await streamChat({
        model,
        system,
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
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, async () => {
  console.log(`listening on http://localhost:${port}`);
  const s = await memosStatus();
  console.log(
    !s.enabled
      ? "memory: OFF (MEMOS_URL / MEMOS_TOKEN not set in the container)"
      : s.ok
        ? "memory: ON (Memos reachable)"
        : `memory: ERROR (${s.error})`,
  );
});
