const $ = (id) => document.getElementById(id);
const els = {
  messages: $("messages"), input: $("input"), form: $("composer"), send: $("send"),
  file: $("file"), attachments: $("attachments"),
  settings: $("settings"), systemPrompt: $("system-prompt"), model: $("model"),
};

const MAX_IMAGES = 4;
const state = { busy: false, abort: null, hasMore: false, firstId: null, lastDay: null, loadingMore: false, pending: [], stick: true, lastId: null };

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
  state.lastId = data.messages.at(-1).id;
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
      } else if (event === "game") {
        if (game.open) gameLoad();
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
    if (game.open) gameLoad();
    // 这是第一条消息：重新加载一次，拿到数据库里的 id 才能往前翻页
    if (!failed) await syncIds();
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
  loadProactiveUI();
  els.settings.showModal();
  try {
    const s = await api("/memory/status");
    if (!s.enabled) showMemoryStatus("记忆：未配置（服务器没读到 MEMOS_URL / MEMOS_TOKEN）", true);
    else if (s.ok) showMemoryStatus("记忆：已连接 Memos", false);
    else showMemoryStatus("记忆：连不上 Memos。" + s.error, true);
  } catch {
    showMemoryStatus("", false);
  }
  try {
    const w = await api("/weread/status");
    if (!w.enabled) showMemoryStatus("读书：未配置（服务器没读到 WEREAD_API_KEY）", true, "weread-status");
    else if (w.ok) showMemoryStatus("读书：已连接微信读书", false, "weread-status");
    else showMemoryStatus("读书：连不上微信读书。" + w.error, true, "weread-status");
  } catch {
    showMemoryStatus("", false, "weread-status");
  }
};
function showMemoryStatus(text, bad, id = "memory-status") {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle("bad", bad);
}
els.settings.addEventListener("close", async () => {
  if (els.settings.returnValue === "save") {
    await api("/settings", { method: "PUT", body: { system_prompt: els.systemPrompt.value } });
    await api("/thread", { method: "PATCH", body: { model: els.model.value } });
    localStorage.setItem("model", els.model.value);
    try {
      await api("/proactive", {
        method: "PUT",
        body: { enabled: $("pro-on").checked, quietStart: $("pro-qs").value, quietEnd: $("pro-qe").value, maxPerDay: Number($("pro-max").value), tz: timeZone() },
      });
    } catch (err) {
      alert("主动消息设置没保存上：" + err.message);
    }
  }
  els.settings.returnValue = "";
});

// ---- 通知与主动消息 ----
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function setStatus(id, text, bad = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle("bad", bad);
}

function keyToBytes(b64) {
  const raw = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function pushState() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  return reg && (await reg.pushManager.getSubscription()) ? "on" : "off";
}

async function refreshPushStatus() {
  const s = await pushState();
  const text = {
    unsupported: "通知：这里还不能收推送。iPhone 需要先「添加到主屏幕」，再从主屏幕上的图标打开。",
    denied: "通知：权限被拒绝了，去 系统设置 → 通知 里打开。",
    on: "通知：本机已开启",
    off: "通知：本机还没开启",
  }[s];
  setStatus("push-status", text, s === "unsupported" || s === "denied");
}

async function enablePush() {
  if ((await pushState()) === "unsupported") return refreshPushStatus();
  try {
    if ((await Notification.requestPermission()) !== "granted") return refreshPushStatus();
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const { key } = await api("/push/key");
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(key) }));
    await api("/push/subscribe", { method: "POST", body: { subscription: sub.toJSON(), tz: timeZone() } });
    setStatus("push-status", "通知：本机已开启");
  } catch (err) {
    setStatus("push-status", "开启通知失败：" + err.message, true);
  }
}

async function loadProactiveUI() {
  try {
    const p = await api("/proactive");
    $("pro-on").checked = p.enabled;
    $("pro-qs").value = p.quietStart;
    $("pro-qe").value = p.quietEnd;
    $("pro-max").value = String(p.maxPerDay);
  } catch { /* 读不到就保持默认 */ }
  refreshPushStatus();
  try {
    const d = await api("/device/status");
    if (!d.enabled) setStatus("device-status", "设备：未配置（服务器没读到 DEVICE_TOKEN）", true);
    else if (!d.last) setStatus("device-status", "设备：已配置，还没收到事件");
    else {
      const min = Math.round((Date.now() - d.last.at) / 60000);
      const ago = min < 90 ? `${min} 分钟前` : `${Math.round(min / 60)} 小时前`;
      setStatus("device-status", `设备：最近一条是 ${ago}（${d.last.kind}${d.last.app ? " " + d.last.app : ""}）`);
    }
  } catch { setStatus("device-status", ""); }
}

$("push-enable").onclick = enablePush;
$("push-test").onclick = async () => {
  try {
    const r = await api("/push/test", { method: "POST" });
    setStatus("push-status", r.sent ? `测试通知已发出（${r.sent} 台设备）` : "没有已开启通知的设备，先点「开启本机通知」", !r.sent);
  } catch (err) { setStatus("push-status", "发送失败：" + err.message, true); }
};
$("pro-run").onclick = async () => {
  const btn = $("pro-run");
  btn.disabled = true;
  setStatus("push-status", "让它想想要说什么…");
  try {
    const r = await api("/proactive/run", { method: "POST" });
    if (r.status === "sent") {
      setStatus("push-status", r.pushed ? "已发出，手机上应该很快弹通知。" : "已写进聊天，但还没有设备开启通知，所以没推送。");
      await refreshThread(true);
    } else setStatus("push-status", "这次没发：" + r.reason, true);
  } catch (err) { setStatus("push-status", "失败：" + err.message, true); }
  btn.disabled = false;
};

// 回到页面时，如果有新消息（比如它主动发的）就刷新
async function syncIds() {
  const d = await api("/thread?limit=40").catch(() => null);
  if (!d) return;
  state.lastId = d.messages.at(-1)?.id ?? null;
  if (state.firstId == null) { state.hasMore = d.hasMore; state.firstId = d.messages[0]?.id ?? null; }
}
async function refreshThread(force = false) {
  if (state.busy) return;
  const d = await api("/thread?limit=40").catch(() => null);
  if (!d || !d.messages.length) return;
  if (!force && d.messages.at(-1).id === state.lastId) return;
  const { nodes, lastDay } = renderBatch(d.messages);
  els.messages.replaceChildren(...nodes);
  state.firstId = d.messages[0].id;
  state.lastId = d.messages.at(-1).id;
  state.hasMore = d.hasMore;
  state.lastDay = lastDay;
  scrollDown(true);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshThread();
});
// 已经授权过的话，启动时更新一下 Service Worker
if ("serviceWorker" in navigator && "Notification" in window && Notification.permission === "granted") {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
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

// ---- 数独 ----
const game = { open: false, state: null, sel: -1, cells: [] };
const boardEl = $("board");

function buildBoard() {
  for (let i = 0; i < 81; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "gridcell");
    b.dataset.i = i;
    const r = Math.floor(i / 9), c = i % 9;
    b.className = "cell" + (r === 0 ? " r0" : r % 3 === 0 ? " bt" : "") + (c === 0 ? " c0" : c % 3 === 0 ? " bl" : "");
    b.onclick = () => { game.sel = i; renderGame(); };
    boardEl.append(b);
    game.cells.push(b);
  }
  const pad = $("pad");
  for (let n = 1; n <= 9; n++) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = n;
    b.onclick = () => gameMove(n);
    pad.append(b);
  }
  const erase = document.createElement("button");
  erase.type = "button"; erase.setAttribute("aria-label", "擦除");
  erase.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  erase.onclick = () => gameMove(0);
  pad.append(erase);
}

async function gameLoad() {
  try { game.state = await api("/game/sudoku"); } catch { return; }
  renderGame();
}

function renderGame() {
  const s = game.state;
  if (!s) return;
  if (!game.cells.length) buildBoard();
  const bad = new Set(s.conflicts);
  const sel = game.sel;
  const selVal = sel >= 0 ? s.cells[sel] : "0";
  const sr = Math.floor(sel / 9), sc = sel % 9;
  game.cells.forEach((b, i) => {
    const v = s.cells[i];
    const who = s.by[i];
    const r = Math.floor(i / 9), c = i % 9;
    const peer = sel >= 0 && i !== sel && (r === sr || c === sc || (Math.floor(r / 3) === Math.floor(sr / 3) && Math.floor(c / 3) === Math.floor(sc / 3)));
    b.textContent = v === "0" ? "" : v;
    b.classList.toggle("g", who === "g");
    b.classList.toggle("p", who === "p");
    b.classList.toggle("c", who === "c");
    b.classList.toggle("bad", bad.has(i));
    b.classList.toggle("sel", i === sel);
    b.classList.toggle("peer", peer);
    b.classList.toggle("same", i !== sel && selVal !== "0" && v === selVal);
    b.setAttribute("aria-label", `第${r + 1}行第${c + 1}列${v === "0" ? "空" : v}`);
  });
  $("game-meta").textContent = s.solvedAt ? `${s.label} · 已完成` : `${s.label} · 还剩 ${s.empty} 格`;
}

async function gameMove(value) {
  const s = game.state;
  if (!s || game.sel < 0 || s.puzzle[game.sel] !== "0" || s.solvedAt) return;
  const v = String(value) === s.cells[game.sel] ? 0 : value; // 再点一次同一个数字 = 擦掉
  try {
    game.state = await api("/game/sudoku/move", { method: "POST", body: { index: game.sel, value: v } });
  } catch { return; }
  renderGame();
  if (game.state.solvedAt && !s.solvedAt && !state.busy) send("我做完了。", []);
}

function askClaude(text) {
  if (!state.busy) send(text, []);
}

$("game-btn").onclick = () => {
  game.open = !game.open;
  $("game").hidden = !game.open;
  $("game-btn").setAttribute("aria-pressed", String(game.open));
  if (game.open) gameLoad();
  else scrollDown(true);
};
$("g-hint").onclick = () => askClaude("给我个提示，先别直接说答案。");
$("g-step").onclick = () => askClaude("你来走下一步，走完告诉我为什么这么下。");
$("g-new").onclick = () => $("new-game").showModal();
$("new-game").addEventListener("close", async (e) => {
  const level = e.target.returnValue;
  e.target.returnValue = "";
  if (!["easy", "medium", "hard"].includes(level)) return;
  const s = game.state;
  if (s && !s.solvedAt && s.moves > 0 && !confirm("放弃现在这盘，开新的？")) return;
  game.state = await api("/game/sudoku/new", { method: "POST", body: { difficulty: level } });
  game.sel = -1;
  renderGame();
});
// 电脑键盘：数字填入，退格擦除，方向键移动
document.addEventListener("keydown", (e) => {
  if (!game.open || e.target.matches("textarea, input, select") || e.metaKey || e.ctrlKey) return;
  if (/^[1-9]$/.test(e.key)) gameMove(Number(e.key));
  else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") gameMove(0);
  else if (e.key.startsWith("Arrow") && game.sel >= 0) {
    const d = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 }[e.key];
    const next = game.sel + d;
    const sameRow = Math.floor(next / 9) === Math.floor(game.sel / 9);
    if (next >= 0 && next < 81 && (Math.abs(d) === 9 || sameRow)) { game.sel = next; renderGame(); e.preventDefault(); }
  }
});

(async function init() {
  const { models } = await api("/models");
  els.model.replaceChildren(...models.map((m) => new Option(m.label, m.id)));
  await loadThread();
  if ((await api("/session")).auth) $("logout").hidden = false;
})();
