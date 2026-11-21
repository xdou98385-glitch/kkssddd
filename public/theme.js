// 在页面画出来之前就定好主题，免得闪一下。默认「终端」，设置里能切回原来的样子。
(function () {
  var t = "term";
  try { t = localStorage.getItem("theme") || "term"; } catch (e) { /* 读不到就用默认 */ }
  document.documentElement.dataset.theme = t;
  var m = document.querySelector('meta[name="theme-color"]');
  if (t === "term") document.querySelectorAll('meta[name="theme-color"]').forEach(function (x) { x.setAttribute("content", "#0c1116"); });
})();
