const $ = (id) => document.getElementById(id);
const els = {
  messages: $("messages"), input: $("input"), form: $("composer"), send: $("send"),
  file: $("file"), attachments: $("attachments"),
  settings: $("settings"), systemPrompt: $("system-prompt"), model: $("model"),
};

const MAX_IMAGES = 4;
const state = { busy: false, abort: null, hasMore: false, firstId: null, lastDay: null, loadingMore: false, pending: [], stick: true };

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = "/login"; throw new Error("unauthorized"); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

const renderMarkdown = (text) => DOMPurify.sanitize(marked.parse(text, { breaks: true }));

const pad = (n) => String(n).padStart(2, "0");
const fmtTime = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`; };

function bubble(role, text, images = [], ts = null) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + role;
  const b = document.createElement("div");
  b.className = "bubble" + (role === "user" ? " bubble-user" : "");
  if (images.length) {
    const pics = document.createElement("div");
    pics.className = "pics";
    for (const name of images) {
      const img = document.createElement("img");
      img.src = "/uploads/" + name;
      img.loading = "lazy";
      img.alt = "";
      img.onload = () => { if (state.stick) els.messages.scrollTop = els.messages.scrollHeight; };
      img.onclick = () => openLightbox(img.src);
      pics.append(img);
    }
    b.append(pics);
  }
  if (role === "assistant") b.insertAdjacentHTML("beforeend", renderMarkdown(text));
  else if (text) b.append(document.createTextNode(text));
  wrap.append(b);
  if (ts) setTime(wrap, ts);
  return { wrap, b };
}

function setTime(wrap, ts) {
  wrap.querySelector(".time")?.remove();
  const t = document.createElement("div");
  t.className = "time";
  t.textContent = fmtTime(ts);
  wrap.append(t);
}

function toolNote(label) {
  const n = document.createElement("div");
  n.className = "tool";
  n.textContent = label;
  return n;
}

function dayDivider(key) {
  const d = document.createElement("div");
  d.className = "day";
  d.dataset.day = key;
  d.textContent = key;
  return d;
}

function openLightbox(src) {
  const box = document.createElement("div");
  box.id = "lightbox";
  box.innerHTML = `<img src="${src}">`;
  box.onclick = () => box.remove();
  document.body.append(box);
}

function scrollDown(force) {
  const m = els.messages;
  if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 120) m.scrollTop = m.scrollHeight;
}

// ---- 加载历史 ----
function renderBatch(msgs) {
  const nodes = [];
  let day = null;
  for (const m of msgs) {
    const k = dayKey(m.created_at);
    if (k !== day) { nodes.push(dayDivider(k)); day = k; }
    nodes.push(bubble(m.role, m.content, m.images, m.created_at).wrap);
  }
  return { nodes, lastDay: day };
}

function showEmpty() {
  els.messages.innerHTML = '<div class="empty"><img class="hero" src="/hero.png" alt=""><span>想聊点什么？</span></div>';
  state.firstId = null;
  state.lastDay = null;
}

async function loadThread() {
  els.messages.innerHTML = '<div class="skeleton" aria-hidden="true"><i></i><i></i><i></i></div>';
  let data;
  try {
    data = await api("/thread?limit=40");
  } catch (err) {
    if (err.message === "unauthorized") return;
    els.messages.innerHTML = '<div class="fail"><span>连不上服务器</span><button type="button">重试</button></div>';
    els.messages.querySelector("button").onclick = loadThread;
    return;
  }
  els.model.value = data.conversation.model;
  state.hasMore = data.hasMore;
  if (!data.messages.length) return showEmpty();
  const { nodes, lastDay } = renderBatch(data.messages);
  els.messages.replaceChildren(...nodes);
  state.firstId = data.messages[0].id;
  state.lastDay = lastDay;
  scrollDown(true);
}

async function loadEarlier() {
  if (state.loadingMore || !state.hasMore || state.firstId == null) return;
  state.loadingMore = true;
  try {
    const data = await api(`/thread?limit=40&before=${state.firstId}`);
    const m = els.messages;
    const prevHeight = m.scrollHeight;
    state.hasMore = data.hasMore;
    const { nodes, lastDay } = renderBatch(data.messages);
    const first = m.querySelector(".day");
    if (first && first.dataset.day === lastDay && first === m.firstElementChild) first.remove();
    m.prepend(...nodes);
    if (data.messages.length) state.firstId = data.messages[0].id;
    m.scrollTop += m.scrollHeight - prevHeight; // 保持当前位置不跳
  } finally {
    state.loadingMore = false;
  }
}
els.messages.addEventListener("scroll", () => {
  const m = els.messages;
  state.stick = m.scrollHeight - m.scrollTop - m.clientHeight < 120; // 在底部附近时，图片加载完要补滚
  if (m.scrollTop < 80) loadEarlier();
});

// ---- 图片：压缩到长边 1568px 的 JPEG 再上传，省流量也省 token ----
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => fail(new Error("这张图读不出来"));
      i.src = url;
    });
    const scale = Math.min(1, 1568 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // 透明 PNG 铺白底
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((ok) => canvas.toBlob(ok, "image/jpeg", 0.85));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function addImages(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    if (state.pending.length >= MAX_IMAGES) { alert(`一条消息最多 ${MAX_IMAGES} 张图`); break; }
    const item = { id: null, preview: URL.createObjectURL(file) };
    state.pending.push(item);
    renderChips();
    try {
      const blob = await shrink(file);
      const res = await fetch("/api/upload", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
      if (res.status === 401) return (location.href = "/login");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "上传失败");
      item.id = (await res.json()).id;
    } catch (err) {
      alert(err.message);
      state.pending = state.pending.filter((p) => p !== item);
    }
    renderChips();
  }
}

function renderChips() {
  els.attachments.replaceChildren(
    ...state.pending.map((p) => {
      const chip = document.createElement("div");
      chip.className = "chip" + (p.id ? "" : " loading");
      const img = document.createElement("img");
      img.src = p.preview;
      const x = document.createElement("button");
      x.type = "button"; x.setAttribute("aria-label", "移除");
      x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      x.onclick = () => { state.pending = state.pending.filter((q) => q !== p); renderChips(); };
      chip.append(img, x);
      return chip;
    }),
  );
}

$("attach").onclick = () => els.file.click();
els.file.addEventListener("change", () => { addImages([...els.file.files]); els.file.value = ""; });
els.input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); addImages(files); }
});

// ---- 发送 ----
async function send(text, images) {
  els.messages.querySelector(".empty")?.remove();
  const sentAt = Date.now();
  if (state.lastDay !== dayKey(sentAt)) {
    els.messages.append(dayDivider(dayKey(sentAt)));
    state.lastDay = dayKey(sentAt);
  }
  const mine = bubble("user", text, images, sentAt);
  mine.wrap.classList.add("enter");
  els.messages.append(mine.wrap);
  const reply = bubble("assistant", "");
  reply.wrap.classList.add("enter");
  reply.b.classList.add("cursor");
  els.messages.append(reply.wrap);
  scrollDown(true);

  setBusy(true);
  let acc = "";
  let failed = "";
  state.abort = new AbortController();
  try {
    const res = await fetch("/api/thread/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, images }),
      signal: state.abort.signal,
    });
    if (res.status === 401) { location.href = "/login"; return; }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    await readSSE(res.body, (event, data) => {
      if (event === "text") {
        acc += data;
        reply.b.innerHTML = renderMarkdown(acc);
        scrollDown();
      } else if (event === "tool") {
        reply.wrap.before(toolNote(data));
        scrollDown();
      } else if (event === "error") failed = data;
    });
  } catch (err) {
    if (err.name !== "AbortError") failed = err.message;
  } finally {
    reply.b.classList.remove("cursor");
    if (acc) setTime(reply.wrap, Date.now());
    else reply.wrap.remove();
    if (failed) {
      const e = bubble("assistant", "");
      e.b.classList.add("err");
      e.b.textContent = failed;
      els.messages.append(e.wrap);
      scrollDown();
    }
    setBusy(false);
    // 这是第一条消息：重新加载一次，拿到数据库里的 id 才能往前翻页
    if (state.firstId == null && !failed) loadThread();
  }
}

async function readSSE(stream, onEvent) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message", data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

function setBusy(busy) {
  state.busy = busy;
  els.send.classList.toggle("busy", busy);
  els.send.setAttribute("aria-label", busy ? "停止" : "发送");
}

function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = els.input.scrollHeight + "px";
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.busy) return state.abort?.abort();
  if (state.pending.some((p) => !p.id)) return; // 图片还在上传
  const text = els.input.value.trim();
  const images = state.pending.map((p) => p.id);
  if (!text && !images.length) return;
  els.input.value = "";
  state.pending = [];
  renderChips();
  autosize();
  send(text, images);
});
// 电脑上 Enter 发送、Shift+Enter 换行；手机上 Enter 换行
els.input.addEventListener("keydown", (e) => {
  const desktop = matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (desktop && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    els.form.requestSubmit();
  }
});
els.input.addEventListener("input", autosize);

// ---- 设置 ----
$("settings-btn").onclick = async () => {
  els.systemPrompt.value = (await api("/settings")).system_prompt;
  showMemoryStatus("检查记忆连接…", false);
  els.settings.showModal();
  try {
    const s = await api("/memory/status");
    if (!s.enabled) showMemoryStatus("记忆：未配置（服务器没读到 MEMOS_URL / MEMOS_TOKEN）", true);
    else if (s.ok) showMemoryStatus("记忆：已连接 Memos", false);
    else showMemoryStatus("记忆：连不上 Memos。" + s.error, true);
  } catch {
    showMemoryStatus("", false);
  }
};
function showMemoryStatus(text, bad) {
  const el = $("memory-status");
  el.textContent = text;
  el.classList.toggle("bad", bad);
}
els.settings.addEventListener("close", async () => {
  if (els.settings.returnValue === "save") {
    await api("/settings", { method: "PUT", body: { system_prompt: els.systemPrompt.value } });
    await api("/thread", { method: "PATCH", body: { model: els.model.value } });
    localStorage.setItem("model", els.model.value);
  }
  els.settings.returnValue = "";
});
$("reset").onclick = async () => {
  if (state.busy) return;
  if (!confirm("清空聊天界面重新开始？\n记忆（Memos）不受影响，聊天记录在数据库里仍然保留。")) return;
  await api("/thread/reset", { method: "POST" });
  els.settings.close("cancel");
  await loadThread();
};
$("logout").onclick = async () => {
  await fetch("/logout", { method: "POST" });
  location.href = "/login";
};

(async function init() {
  const { models } = await api("/models");
  els.model.replaceChildren(...models.map((m) => new Option(m.label, m.id)));
  await loadThread();
  if ((await api("/session")).auth) $("logout").hidden = false;
})();
