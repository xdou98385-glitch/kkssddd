// Service Worker：只负责接收推送、弹通知、点通知时回到应用。不缓存任何页面。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { /* 不是 JSON 就用默认值 */ }
  event.waitUntil(
    self.registration.showNotification(d.title || "Claude", {
      body: d.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "claude-message", // 同一个 tag 的新通知会替换旧的，不会堆一排
      renotify: true,
      data: { url: d.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) { await w.focus(); return; }
      }
      await self.clients.openWindow(event.notification.data?.url || "/");
    })(),
  );
});
