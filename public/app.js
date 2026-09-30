const $ = (id) => document.getElementById(id);
const els = {
  list: $("conv-list"), messages: $("messages"), title: $("title"), model: $("model"),
  input: $("input"), form: $("composer"), send: $("send"),
  settings: $("settings"), systemPrompt: $("system-prompt"),
};

const state = { conv: null, convs: [], busy: false, abort: null };

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

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text, { breaks: true }));
}

function bubble(role, text) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + role;
  const b = document.createElement("div");
  b.className = "bubble";
  if (role === "user" || role === "tool") b.textContent = text;
  else b.innerHTML = renderMarkdown(text);
  wrap.append(b);
  els.messages.append(wrap);
  return b;
}

function scrollDown(force) {
  const m = els.messages;
  if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 120) m.scrollTop = m.scrollHeight;
}

function renderList() {
  els.list.replaceChildren(
    ...state.convs.map((c) => {
      const li = document.createElement("li");
      if (state.conv && c.id === state.conv.id) li.className = "active";
      const t = document.createElement("span");
      t.className = "t"; t.textContent = c.title;
      const del = document.createElement("button");
      del.className = "del"; del.textContent = "✕"; del.title = "删除";
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`删除「${c.title}」？`)) return;
        await api("/conversations/" + c.id, { method: "DELETE" });
        if (state.conv?.id === c.id) { state.conv = null; showEmpty(); }
        await loadList();
      };
      li.append(t, del);
      li.onclick = () => openConv(c.id);
      return li;
    }),
  );
}

async function loadList() {
  state.convs = await api("/conversations");
  renderList();
}

function showEmpty() {
  els.messages.innerHTML = '<div class="empty">想聊点什么？</div>';
  els.title.textContent = "新对话";
  renderList();
}

async function openConv(id) {
  if (state.busy) return;
  const { conversation, messages } = await api(`/conversations/${id}/messages`);
  state.conv = conversation;
  els.title.textContent = conversation.title;
  els.model.value = conversation.model;
  els.messages.replaceChildren();
  messages.forEach((m) => bubble(m.role, m.content));
  scrollDown(true);
  renderList();
  document.body.classList.remove("side-open");
}

async function newConv() {
  if (state.busy) return;
  state.conv = null;
  showEmpty();
  document.body.classList.remove("side-open");
  els.input.focus();
}

async function send(text) {
  if (!state.conv) {
    state.conv = await api("/conversations", { method: "POST", body: { model: els.model.value } });
  }
  if (els.messages.querySelector(".empty")) els.messages.replaceChildren();
  bubble("user", text);
  const out = bubble("assistant", "");
  out.classList.add("cursor");
  scrollDown(true);

  setBusy(true);
  let acc = "";
  let failed = "";
  state.abort = new AbortController();
  try {
    const res = await fetch(`/api/conversations/${state.conv.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
      signal: state.abort.signal,
    });
    if (res.status === 401) { location.href = "/login"; return; }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    await readSSE(res.body, (event, data) => {
      if (event === "text") {
        acc += data;
        out.innerHTML = renderMarkdown(acc);
        scrollDown();
      } else if (event === "tool") {
        const note = bubble("tool", "");
        note.textContent = data;
        note.parentElement.remove();
        out.parentElement.before(note.parentElement);
        scrollDown();
      } else if (event === "error") failed = data;
      else if (event === "done") { state.conv = data; els.title.textContent = data.title; }
    });
  } catch (err) {
    if (err.name !== "AbortError") failed = err.message;
  } finally {
    out.classList.remove("cursor");
    if (failed) {
      const e = bubble("assistant", "");
      e.classList.add("err");
      e.textContent = "⚠ " + failed;
    }
    setBusy(false);
    await loadList();
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
  els.send.textContent = busy ? "停止" : "发送";
  els.send.classList.toggle("primary", !busy);
}

function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = els.input.scrollHeight + "px";
}

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.busy) return state.abort?.abort();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = "";
  autosize();
  send(text);
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

els.model.addEventListener("change", async () => {
  if (state.conv) await api("/conversations/" + state.conv.id, { method: "PATCH", body: { model: els.model.value } });
  localStorage.setItem("model", els.model.value);
});

$("logout").onclick = async () => {
  await fetch("/logout", { method: "POST" });
  location.href = "/login";
};
$("new-chat").onclick = newConv;
$("menu-btn").onclick = () => document.body.classList.add("side-open");
$("scrim").onclick = () => document.body.classList.remove("side-open");
$("settings-btn").onclick = async () => {
  els.systemPrompt.value = (await api("/settings")).system_prompt;
  els.settings.showModal();
};
els.settings.addEventListener("close", async () => {
  if (els.settings.returnValue === "save")
    await api("/settings", { method: "PUT", body: { system_prompt: els.systemPrompt.value } });
  els.settings.returnValue = "";
});

(async function init() {
  const { models, default: def } = await api("/models");
  els.model.replaceChildren(...models.map((m) => new Option(m.label, m.id)));
  els.model.value = localStorage.getItem("model") || def;
  await loadList();
  if ((await api("/session")).auth) $("logout").hidden = false;
})();
