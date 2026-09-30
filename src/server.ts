import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { basicAuth } from "hono/basic-auth";
import { streamSSE } from "hono/streaming";
import * as db from "./db.ts";
import { DEFAULT_MODEL, MODELS, describeError, findModel, streamChat } from "./claude.ts";

const app = new Hono();

// 可选的站点密码（放在 Tailscale 私网里的话可以不设）
const password = process.env.APP_PASSWORD;
if (password) {
  app.use("*", basicAuth({ username: process.env.APP_USER ?? "me", password }));
}

// 前端依赖直接从 node_modules 提供，省掉构建步骤
app.get("/vendor/marked.js", serveStatic({ path: "node_modules/marked/lib/marked.umd.js" }));
app.get("/vendor/purify.js", serveStatic({ path: "node_modules/dompurify/dist/purify.min.js" }));

app.get("/api/models", (c) => c.json({ models: MODELS, default: DEFAULT_MODEL }));

app.get("/api/settings", (c) => c.json({ system_prompt: db.getSetting("system_prompt") }));
app.put("/api/settings", async (c) => {
  const body = await c.req.json<{ system_prompt?: string }>();
  db.setSetting("system_prompt", String(body.system_prompt ?? ""));
  return c.json({ ok: true });
});

app.get("/api/conversations", (c) => c.json(db.listConversations()));

app.post("/api/conversations", async (c) => {
  const body = await c.req.json<{ model?: string }>().catch(() => ({ model: undefined }));
  const model = body.model && findModel(body.model) ? body.model : DEFAULT_MODEL;
  return c.json(db.createConversation(model));
});

app.patch("/api/conversations/:id", async (c) => {
  const id = c.req.param("id");
  if (!db.getConversation(id)) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ title?: string; model?: string }>();
  if (body.model !== undefined && !findModel(body.model))
    return c.json({ error: "unknown model" }, 400);
  db.updateConversation(id, { title: body.title?.trim() || undefined, model: body.model });
  return c.json(db.getConversation(id));
});

app.delete("/api/conversations/:id", (c) => {
  db.deleteConversation(c.req.param("id"));
  return c.json({ ok: true });
});

app.get("/api/conversations/:id/messages", (c) => {
  const id = c.req.param("id");
  const conv = db.getConversation(id);
  if (!conv) return c.json({ error: "not found" }, 404);
  return c.json({ conversation: conv, messages: db.listMessages(id) });
});

// 发送一条消息，回复用 SSE 流式返回
app.post("/api/conversations/:id/chat", async (c) => {
  const id = c.req.param("id");
  const conv = db.getConversation(id);
  if (!conv) return c.json({ error: "not found" }, 404);
  const { content } = await c.req.json<{ content?: string }>();
  const userText = String(content ?? "").trim();
  if (!userText) return c.json({ error: "empty message" }, 400);
  const model = findModel(conv.model) ?? MODELS[0];

  const isFirst = db.listMessages(id).length === 0;
  db.addMessage(id, "user", userText);
  if (isFirst) db.updateConversation(id, { title: userText.replace(/\s+/g, " ").slice(0, 30) });

  return streamSSE(c, async (sse) => {
    const abort = new AbortController();
    sse.onAbort(() => abort.abort());
    let text = "";
    try {
      const history = db.listMessages(id).map((m) => ({ role: m.role, content: m.content }));
      const result = await streamChat({
        model,
        system: db.getSetting("system_prompt"),
        messages: history,
        signal: abort.signal,
        onText: (delta) => void sse.writeSSE({ event: "text", data: JSON.stringify(delta) }),
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
    if (text) db.addMessage(id, "assistant", text);
    await sse.writeSSE({ event: "done", data: JSON.stringify(db.getConversation(id)) });
  });
});

app.use("*", serveStatic({ root: "public" }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, () =>
  console.log(`listening on http://localhost:${port}`),
);
