const $ = (id) => document.getElementById(id);
const els = {
  messages: $("messages"), input: $("input"), form: $("composer"), send: $("send"),
  file: $("file"), attachments: $("attachments"),
  settings: $("settings"), systemPrompt: $("system-prompt"), model: $("model"),
};

const MAX_IMAGES = 4;
const state = { busy: false, abort: null, hasMore: false, firstId: null, lastDay: null, loadingMore: false, pending: [], stick: true, lastId: null, tts: false, call: false };

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

// 历史里只存了工具名，没存当次的参数，所以刷新后用通用小字
const TOOL_LABELS = {
  search_memories: "翻了记忆",
  save_memory: "记了一笔",
  sudoku_view: "看了眼棋盘",
  sudoku_hint: "想了个提示",
  sudoku_place: "落了子",
  weread: "查了微信读书",
  device_activity: "看了眼她手机最近在干嘛",
  get_time: "看了眼时间",
};

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
    if (m.role === "assistant") for (const t of m.tools || []) nodes.push(toolNote(TOOL_LABELS[t] || t));
    const b = bubble(m.role, m.content, m.images, m.created_at);
    if (m.kind) b.wrap.dataset.kind = m.kind;
    if (m.role === "assistant") { b.wrap.dataset.id = m.id; addSpeak(b.wrap); }
    nodes.push(b.wrap);
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
  state.tts = Boolean(data.tts);
  $("tab-radio").hidden = !state.tts;
  $("tab-call").hidden = !data.call;
  state.call = Boolean(data.call);
  if (location.hash === "#radio") setPage("radio");
  els.model.value = data.conversation.model;
  state.hasMore = data.hasMore;
  if (!data.messages.length) return showEmpty();
  const { nodes, lastDay } = renderBatch(data.messages);
  els.messages.replaceChildren(...nodes);
  state.firstId = data.messages[0].id;
  state.lastId = data.messages.at(-1).id;
  state.lastDay = lastDay;
  scrollDown(true);
  if (!state.busy) markRegen();
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
  await runReply("/api/thread/chat", { content: text, images, tz: timeZone() });
}

// 流式接收一条回复（发送和重新生成共用）
async function runReply(url, payload) {
  clearRegen();
  els.messages.querySelector(".empty")?.remove();
  if (game.open) $("game-say").textContent = "";
  const reply = bubble("assistant", "");
  reply.wrap.classList.add("enter");
  reply.b.classList.add("cursor");
  els.messages.append(reply.wrap);
  scrollDown(true);

  setBusy(true);
  let acc = "";
  let failed = "";
  let doneId = null;
  state.abort = new AbortController();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: state.abort.signal,
    });
    if (res.status === 401) { location.href = "/login"; return; }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    await readSSE(res.body, (event, data) => {
      if (event === "text") {
        acc += data;
        reply.b.innerHTML = renderMarkdown(acc);
        if (game.open) $("game-say").innerHTML = renderMarkdown(acc);
        scrollDown();
      } else if (event === "tool") {
        reply.wrap.before(toolNote(data));
        scrollDown();
      } else if (event === "game") {
        if (game.open) gameLoad();
      } else if (event === "done") doneId = data?.id ?? null;
      else if (event === "error") failed = data;
    });
  } catch (err) {
    if (err.name !== "AbortError") failed = err.message;
  } finally {
    reply.b.classList.remove("cursor");
    if (acc) {
      setTime(reply.wrap, Date.now());
      if (doneId) { reply.wrap.dataset.id = doneId; addSpeak(reply.wrap); }
    } else reply.wrap.remove();
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
    markRegen();
  }
  return failed;
}

// ---- 朗读 ----
const SPEAK_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const STOP_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
let speaking = null; // { btn, audio }

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 3000);
}

function stopSpeaking() {
  if (!speaking) return;
  const { btn, audio } = speaking;
  speaking = null;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  btn.classList.remove("on", "loading");
  btn.innerHTML = SPEAK_ICON;
  deckSet("—", 0, 0);
}

// 点一下播放，再点停止。必须在点击里同步 play()，iPhone 才不会拦；音频由浏览器自己请求
function toggleSpeak(btn, id, meta) {
  const was = speaking?.btn === btn;
  stopSpeaking();
  if (was) return;
  const url = meta?.url ?? "/api/tts/" + id;
  const audio = new Audio(url);
  speaking = { btn, audio };
  btn.classList.add("on", "loading");
  const title = meta?.title ?? "";
  audio.addEventListener("playing", () => { btn.classList.remove("loading"); btn.innerHTML = STOP_ICON; deckSet(title, audio.currentTime, audio.duration); });
  audio.addEventListener("timeupdate", () => { if (speaking?.audio === audio) deckSet(title, audio.currentTime, audio.duration); });
  audio.addEventListener("ended", () => { if (speaking?.audio === audio) stopSpeaking(); });
  audio.addEventListener("error", async () => {
    if (speaking?.audio !== audio) return;
    stopSpeaking();
    const r = await fetch(url).catch(() => null);
    toast((await r?.json().catch(() => null))?.error || "语音播放失败");
  });
  audio.play().catch((e) => {
    if (speaking?.audio !== audio) return;
    stopSpeaking();
    if (e?.name === "NotAllowedError") toast("点一下就能听");
  });
}

function addSpeak(wrap) {
  if (!state.tts || !wrap.dataset.id || wrap.querySelector(".speak")) return;
  const time = wrap.querySelector(".time");
  if (!time) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "speak";
  btn.title = btn.ariaLabel = "朗读";
  btn.innerHTML = SPEAK_ICON;
  btn.onclick = () => toggleSpeak(btn, wrap.dataset.id, { title: "对话 · " + firstLine(wrap.querySelector(".bubble")?.textContent ?? "") });
  time.append(btn);
}

// ---- 重新生成最后一条回复 ----
function clearRegen() {
  els.messages.querySelectorAll(".regen").forEach((b) => b.remove());
}

// 只有最后一条是「正常的助手回复」时才给按钮；主动消息、报错气泡都不给
function markRegen() {
  clearRegen();
  const last = els.messages.lastElementChild;
  if (!last?.classList.contains("msg") || !last.classList.contains("assistant") || ["proactive", "podcast", "call"].includes(last.dataset.kind)) return;
  if (last.querySelector(".bubble.err")) return;
  let prev = last.previousElementSibling;
  while (prev?.classList.contains("tool")) prev = prev.previousElementSibling;
  if (!prev?.classList.contains("user")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "regen";
  btn.title = btn.ariaLabel = "重新生成";
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
  btn.onclick = regenerate;
  (last.querySelector(".time") ?? last).append(btn);
}

async function regenerate() {
  if (state.busy) return;
  const last = els.messages.lastElementChild;
  if (!last?.classList.contains("msg")) return;
  // 连同它上面的工具小字一起去掉
  while (last.previousElementSibling?.classList.contains("tool")) last.previousElementSibling.remove();
  last.remove();
  const failed = await runReply("/api/thread/regenerate", {});
  if (failed) {
    // 失败了：服务器已把原来那条放回去，重新加载出来，再把报错放在下面
    await refreshThread(true);
    const e = bubble("assistant", "");
    e.b.classList.add("err");
    e.b.textContent = failed;
    els.messages.append(e.wrap);
    scrollDown();
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
  const st = await api("/settings");
  els.systemPrompt.value = st.system_prompt;
  $("window-preset").value = st.window_preset;
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
    await api("/settings", { method: "PUT", body: { system_prompt: els.systemPrompt.value, window_preset: $("window-preset").value } });
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

/** 服务器那边登记了几台设备；查不到返回 null */
async function serverSubCount() {
  try { return (await api("/proactive")).subscriptions; } catch { return null; }
}

async function refreshPushStatus() {
  const s = await pushState();
  // 本机有订阅，不代表服务器还认：服务器清掉失效订阅后，这里要说清楚
  if (s === "on" && (await serverSubCount()) === 0) {
    setStatus("push-status", "通知：本机有订阅，但服务器没有记录（可能已失效）。点「开启本机通知」重新登记。", true);
    return;
  }
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
    let sub = await reg.pushManager.getSubscription();
    // 本机有订阅但服务器已经没有记录：旧订阅多半已失效，丢掉换一个新的
    if (sub && (await serverSubCount()) === 0) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(key) });
    await api("/push/subscribe", { method: "POST", body: { subscription: sub.toJSON(), tz: timeZone() } });
    setStatus("push-status", "通知：本机已开启，并已在服务器登记。可以点「测试通知」了。");
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
    if (r.sent) setStatus("push-status", `测试通知已发出（${r.sent} 台设备）。手机上没弹的话，检查睡眠专注模式和系统通知设置。`);
    else if (r.errors?.length) setStatus("push-status", "推送没成功：" + r.errors.join("；"), true);
    else setStatus("push-status", "服务器没有已开启通知的设备，先点「开启本机通知」", true);
  } catch (err) { setStatus("push-status", "发送失败：" + err.message, true); }
};
$("pro-run").onclick = async () => {
  const btn = $("pro-run");
  btn.disabled = true;
  setStatus("push-status", "让它想想要说什么…");
  try {
    const r = await api("/proactive/run", { method: "POST" });
    if (r.status === "sent") {
      if (r.pushed) setStatus("push-status", "已发出，手机上应该很快弹通知。");
      else if (r.pushErrors?.length) setStatus("push-status", "已写进聊天，但推送没成功：" + r.pushErrors.join("；"), true);
      else setStatus("push-status", "已写进聊天，但服务器没有已开启通知的设备，所以没推送。点「开启本机通知」登记。", true);
      await refreshThread(true);
    } else setStatus("push-status", "这次没发：" + r.reason, true);
  } catch (err) { setStatus("push-status", "失败：" + err.message, true); }
  btn.disabled = false;
};

// ---- 电台页 ----
const TICKS = 28;
$("deck-bar").innerHTML = "<i></i>".repeat(TICKS);
const mmss = (t) => (Number.isFinite(t) ? `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}` : "--:--");

function deckSet(title, cur, total) {
  $("deck-title").textContent = title;
  $("deck-time").textContent = title === "—" ? "--:--" : `${mmss(cur)} / ${mmss(total)}`;
  const lit = total > 0 ? Math.floor((cur / total) * TICKS) : 0;
  $("deck-bar").querySelectorAll("i").forEach((el, i) => el.classList.toggle("on", i < lit));
}

const plain = (t) => t.replace(/[*_`#>~\[\]]/g, "").replace(/\s+/g, " ").trim();
const firstLine = (t) => { const s = plain(t); const m = s.match(/^.{6,34}?[。！？.!?…]/); return m ? m[0] : s.slice(0, 30); };

let epTimer = null;
let epWant = null; // 刚点了「来一期」的那一期：做好后自动播
const epLabel = { writing: "写稿中…", voicing: "配音中…" };

async function loadEpisodes() {
  const list = $("episodes");
  let eps;
  try { eps = (await api("/podcasts")).episodes; } catch { return; }
  const open = new Set([...list.querySelectorAll(".ep.open")].map((li) => li.dataset.id)); // 刷新时保持展开状态
  list.replaceChildren(...eps.map((e, i) => episodeRow(e, eps.length - i, open.has(String(e.id)))));
  if (!eps.length) list.innerHTML = '<li class="ep-empty">还没有。点「来一期」。</li>';

  const pending = eps.some((e) => e.status === "writing" || e.status === "voicing");
  if (pending && !epTimer) epTimer = setInterval(() => document.body.dataset.page === "radio" ? loadEpisodes() : null, 3000);
  if (!pending && epTimer) { clearInterval(epTimer); epTimer = null; }
  const ready = epWant && eps.find((e) => e.id === epWant && e.status === "ready");
  if (ready) {
    epWant = null;
    setStatus("pod-status", "");
    list.querySelector(`.ep[data-id="${ready.id}"] .ep-play`)?.click(); // 尽量直接播；iPhone 拦了会提示点一下
  }
  const failed = epWant && eps.find((e) => e.id === epWant && e.status === "failed");
  if (failed) { epWant = null; setStatus("pod-status", "这期没做成：" + (failed.error || "未知原因"), true); }
}

function episodeRow(e, no, open) {
  const li = document.createElement("li");
  li.className = "ep" + (open ? " open" : "");
  li.dataset.id = e.id;
  const d = new Date(e.created_at);
  const when = `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const num = String(no).padStart(2, "0");
  const ready = e.status === "ready";
  const head = document.createElement("div");
  head.className = "ep-head";
  head.innerHTML = `<span class="ep-no">${num}</span><div class="ep-body"><div class="ep-title"></div><div class="ep-meta"></div></div>`;
  head.querySelector(".ep-title").textContent = e.title || epLabel[e.status] || "没做成";
  head.querySelector(".ep-meta").textContent = e.status === "failed" ? e.error || "" : ready ? `${when}${e.title_en ? " · " + e.title_en : ""}` : `${when} · ${epLabel[e.status] ?? ""}`;
  li.classList.toggle("pending", !ready && e.status !== "failed");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ep-play";
  btn.ariaLabel = "播放";
  btn.innerHTML = SPEAK_ICON;
  btn.disabled = !ready;
  btn.onclick = (ev) => { ev.stopPropagation(); toggleSpeak(btn, e.id, { url: `/api/podcast/${e.id}/audio`, title: `${num} ${e.title_en || e.title}` }); };
  head.append(btn);
  li.append(head);
  if (e.zh) {
    const text = document.createElement("div");
    text.className = "ep-text";
    for (const para of e.zh.split(/\n{2,}/)) { const p = document.createElement("p"); p.textContent = para.trim(); text.append(p); }
    li.append(text);
    head.onclick = () => li.classList.toggle("open"); // 点一下展开/收起文字
  }
  return li;
}

$("pod-run").onclick = async () => {
  const btn = $("pod-run");
  btn.disabled = true;
  setStatus("pod-status", "开始了。写稿加配音大概要一两分钟，可以先去干别的，做好会出现在下面。");
  try {
    const r = await api("/podcast", { method: "POST", body: { topic: $("pod-topic").value.trim() } });
    epWant = r.id;
    $("pod-topic").value = "";
    await loadEpisodes();
  } catch (err) { setStatus("pod-status", "失败：" + err.message, true); }
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
  state.tts = Boolean(d.tts);
  if (!force && d.messages.at(-1).id === state.lastId) return;
  const { nodes, lastDay } = renderBatch(d.messages);
  els.messages.replaceChildren(...nodes);
  state.firstId = d.messages[0].id;
  state.lastId = d.messages.at(-1).id;
  state.hasMore = d.hasMore;
  state.lastDay = lastDay;
  scrollDown(true);
  if (!state.busy) markRegen();
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

// ---- 页面切换：对话 / 电台 / 棋盘 ----
const PAGES = { chat: "Claude", radio: "电台", call: "通话", board: "棋盘" };
function setPage(p) {
  if (!PAGES[p] || (p === "radio" && !state.tts) || (p === "call" && !state.call)) p = "chat";
  if (p !== "call" && call.on) hangUp();
  document.body.dataset.page = p;
  $("title").textContent = PAGES[p];
  document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.page === p)));
  game.open = p === "board";
  $("game").hidden = !game.open;
  $("radio").hidden = p !== "radio";
  $("call").hidden = p !== "call";
  if (game.open) gameLoad();
  if (p === "radio") loadEpisodes();
  if (p === "chat") scrollDown(true);
  history.replaceState(null, "", p === "chat" ? location.pathname : "#" + p);
}

// ---- 通话 ----
// 流程：接通（点一下，拿麦克风、解锁播放）→ 它先开口 → 听你说（检测到停顿就收尾）→ 上传识别 → 它回 → 播放 → 再听
const SILENCE_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
const call = { on: false, state: "idle", stream: null, ctx: null, analyser: null, audio: null, rec: null, next: null, token: 0, t0: 0, timer: null, maxMs: 600000, subs: false };

function callSet(state, label) {
  call.state = state;
  $("call-state").textContent = label;
  $("call-moon").dataset.state = state;
}
function callNote(text, bad = false) { setStatus("call-note", text, bad); }
function callSub(you, it) {
  const el = $("call-subs");
  el.textContent = [you && "you: " + you, it && "claude: " + it].filter(Boolean).join("\n");
}

async function callStart() {
  if (call.on) return;
  callNote("");
  call.audio = new Audio(SILENCE_WAV); // 在点击里先放一段静音，iPhone 之后才允许自动播放它的回复
  await call.audio.play().catch(() => {});
  try {
    call.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    callNote("没拿到麦克风。在 iPhone 设置里允许这个网页用麦克风，再试一次。", true);
    return;
  }
  call.ctx = new (window.AudioContext || window.webkitAudioContext)();
  call.analyser = call.ctx.createAnalyser();
  call.analyser.fftSize = 1024;
  call.ctx.createMediaStreamSource(call.stream).connect(call.analyser);
  call.on = true;
  const token = ++call.token;
  call.t0 = Date.now();
  call.timer = setInterval(() => {
    const ms = Date.now() - call.t0;
    $("call-time").textContent = mmss(ms / 1000);
    if (ms > call.maxMs) { toast("通话时间到了"); hangUp(); }
  }, 500);
  $("call-go").textContent = "挂断";
  $("call-go").classList.add("live");
  callSub("", "");
  // 它先开口
  await callRound(token, null);
}

function hangUp() {
  if (!call.on) return;
  call.on = false;
  call.token++;
  clearInterval(call.timer);
  try { call.rec?.state === "recording" && call.rec.stop(); } catch { /* 已经停了 */ }
  call.rec = null;
  call.audio?.pause();
  call.stream?.getTracks().forEach((t) => t.stop());
  call.ctx?.close().catch(() => {});
  call.stream = call.ctx = call.analyser = null;
  $("call-go").textContent = "接通";
  $("call-go").classList.remove("live");
  callSet("idle", "STANDBY");
  $("call-moon").style.removeProperty("--lvl");
  refreshThread(true); // 通话记录会出现在对话里
}

/** 一轮：blob 为 null 表示刚接通，让它先说话 */
async function callRound(token, blob, durationMs = 0) {
  callSet("thinking", "THINKING");
  let r;
  try {
    const res = await fetch("/api/call/turn", {
      method: "POST",
      headers: blob ? { "Content-Type": blob.type, "X-Duration-Ms": String(Math.round(durationMs)) } : { "X-Call-Start": "1" },
      body: blob ?? "",
    });
    if (res.status === 401) { location.href = "/login"; return; }
    r = await res.json();
    if (!res.ok) throw new Error(r.error || res.statusText);
  } catch (err) {
    if (token !== call.token) return;
    callNote(err.message, true);
    if (/额度/.test(err.message)) return hangUp();
    return callListen(token); // 其他错误：提示一下，接着听
  }
  if (token !== call.token) return;
  if (r.maxMinutes) call.maxMs = r.maxMinutes * 60000;
  if (!r.reply) return callListen(token); // 没听清，接着听
  callSub(r.heard, r.reply);
  if (r.audioError) { callNote(r.audioError, true); return callListen(token); }
  callSet("speaking", "SPEAKING");
  let done = false;
  const next = (msg) => {
    if (done || token !== call.token) return;
    done = true;
    if (msg) callNote(msg, true);
    callListen(token);
  };
  call.next = next;
  call.audio.onended = () => next();
  call.audio.onerror = () => next("播放失败");
  call.audio.src = "/api/tts/" + r.id;
  call.audio.play().catch((e) => {
    if (e?.name === "NotAllowedError") { callNote("点一下月亮就能听到", true); callSet("speaking", "TAP MOON"); }
    else next("播放失败");
  });
}

/** 听她说话：音量过了阈值算开口；开口之后静音超过一小会儿就收尾 */
function callListen(token) {
  if (token !== call.token || !call.on) return;
  callSet("listening", "LISTENING");
  const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((m) => window.MediaRecorder?.isTypeSupported(m));
  if (!mime) { callNote("这个浏览器不能录音", true); return hangUp(); }
  const chunks = [];
  const rec = new MediaRecorder(call.stream, { mimeType: mime });
  call.rec = rec;
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const buf = new Float32Array(call.analyser.fftSize);
  const started = Date.now();
  let base = null, baseN = 0, voiceMs = 0, silenceMs = 0, spoke = false, last = started, spokeAt = 0;
  let discard = false;

  const tick = () => {
    if (token !== call.token || rec.state !== "recording") return;
    call.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    const now = Date.now(), dt = now - last;
    last = now;
    $("call-moon").style.setProperty("--lvl", Math.min(1, rms * 12).toFixed(2));
    if (now - started < 500) { base = ((base ?? 0) * baseN + rms) / (baseN + 1); baseN++; }
    else {
      const thr = Math.max(0.015, (base ?? 0) * 2.5);
      if (rms > thr) { voiceMs += dt; silenceMs = 0; if (voiceMs > 250 && !spoke) { spoke = true; spokeAt = now; } }
      else if (spoke) silenceMs += dt;
      if (spoke && silenceMs >= 1100) return rec.stop();
      if (spoke && now - spokeAt > 25000) return rec.stop(); // 一句话最长 25 秒
      if (!spoke && now - started > 20000) { discard = true; return rec.stop(); } // 一直没人说话，丢掉这段重新听
    }
    requestAnimationFrame(tick);
  };
  rec.onstop = () => {
    if (token !== call.token) return;
    if (discard || !spoke) return callListen(token);
    const blob = new Blob(chunks, { type: mime.split(";")[0] });
    callRound(token, blob, Date.now() - started - silenceMs);
  };
  rec.start();
  requestAnimationFrame(tick);
}

$("call-go").onclick = () => (call.on ? hangUp() : callStart());
$("call-moon").onclick = () => {
  if (!call.on || call.state !== "speaking") return;
  if (call.audio.paused) { callNote(""); callSet("speaking", "SPEAKING"); call.audio.play().catch(() => call.next?.("播放失败")); return; } // 被拦住的自动播放：点一下补上
  call.audio.pause(); // 它正在说：点月亮打断它，轮到你
  call.next?.();
};
$("call-sub-toggle").onclick = () => {
  call.subs = !call.subs;
  $("call-subs").hidden = !call.subs;
  $("call-sub-toggle").textContent = "字幕：" + (call.subs ? "开" : "关");
};
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && call.on) hangUp(); });

// ---- 启动：标签页点击、初始页面（要放在最后，前面的东西都定义好了）----
document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => setPage(b.dataset.page)));
document.body.dataset.page = "chat";
const startPage = location.hash.slice(1);
if (startPage === "board") setPage("board"); // 电台要等知道语音有没有开，loadThread 之后再切
