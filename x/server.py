"""X（推特）只读小服务。每个请求带着 auth_token 和 ct0，用环境变量交给 twitter-cli 跑一条只读命令，把它的 JSON 结果原样带回。

- 只放行读的命令（feed / search / tweet / user / user-posts / bookmarks / whoami）。点赞、发帖、关注、删除这些命令这里一律不接。
- 登录凭据只存在这一次请求的子进程环境变量里，这个服务自己不落盘。
- 一次只处理一个请求（锁），避免短时间连着打 X。
"""
import json
import os
import re
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "18080"))
HOST = os.environ.get("HOST", "0.0.0.0")  # 容器里监听全部网卡，对外只由 docker 绑到 127.0.0.1
CLI = os.environ.get("X_CLI", "twitter")
LOCK = threading.Lock()

NAME = re.compile(r"^[A-Za-z0-9_]{1,15}$")
TID = re.compile(r"^\d{5,25}$")


def clamp(v, default, lo=1, hi=30) -> str:
    try:
        n = int(v)
    except (TypeError, ValueError):
        n = default
    return str(max(lo, min(n, hi)))


def build(cmd: str, b: dict) -> list:
    n = clamp(b.get("count"), 10)
    if cmd == "status":
        return ["status"]
    if cmd == "whoami":
        return ["whoami"]
    if cmd == "feed":
        t = "following" if b.get("type") == "following" else "for-you"
        return ["feed", "-t", t, "--max", n]
    if cmd == "bookmarks":
        return ["bookmarks", "--max", n]
    if cmd == "search":
        q = str(b.get("query") or "").strip()[:200]
        if not q:
            raise ValueError("没有搜索词")
        prod = {"Top": "Top", "Latest": "Latest"}.get(str(b.get("product") or "Top"), "Top")
        return ["search", "-t", prod, "--max", n, "--", q]
    if cmd == "tweet":
        tid = str(b.get("id") or "")
        if not TID.match(tid):
            raise ValueError("推文 id 不对")
        return ["tweet", tid, "--max", clamp(b.get("count"), 8, 1, 20)]
    if cmd == "user":
        u = str(b.get("name") or "").lstrip("@")
        if not NAME.match(u):
            raise ValueError("用户名不对")
        return ["user", u]
    if cmd == "user-posts":
        u = str(b.get("name") or "").lstrip("@")
        if not NAME.match(u):
            raise ValueError("用户名不对")
        return ["user-posts", u, "--max", n]
    raise ValueError("不支持的命令")


def run(cmd: str, b: dict):
    token, ct0 = str(b.get("auth_token") or "").strip(), str(b.get("ct0") or "").strip()
    if not token or not ct0:
        raise ValueError("没有 auth_token / ct0")
    args = [CLI, *build(cmd, b), "--json"]
    # 只给子进程它需要的环境变量；故意不继承别的，也不让它去读浏览器 cookie
    env = {"PATH": os.environ.get("PATH", ""), "HOME": "/tmp", "TWITTER_AUTH_TOKEN": token, "TWITTER_CT0": ct0}
    if os.environ.get("TWITTER_PROXY"):
        env["TWITTER_PROXY"] = os.environ["TWITTER_PROXY"]
    p = subprocess.run(args, capture_output=True, text=True, timeout=75, env=env, cwd="/tmp")
    out = (p.stdout or "").strip()
    try:
        d = json.loads(out)
    except Exception:
        tail = (p.stderr or out or "没有输出").strip().splitlines()[-3:]
        raise RuntimeError(f"twitter-cli 没给出 JSON（退出码 {p.returncode}）：{' / '.join(tail)}"[:400])
    if not d.get("ok"):
        e = d.get("error") or {}
        raise RuntimeError(f"{e.get('code', 'error')}：{e.get('message', '未知错误')}"[:400])
    return {"data": d.get("data"), "next": (d.get("pagination") or {}).get("nextCursor")}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, obj: dict):
        raw = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self._send(200, {"ok": True}) if self.path == "/health" else self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        cmd = self.path.strip("/")
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except Exception:
            return self._send(400, {"ok": False, "error": "请求体不是 JSON"})
        try:
            with LOCK:
                data = run(cmd, body)
            self._send(200, {"ok": True, "data": data})
        except subprocess.TimeoutExpired:
            self._send(504, {"ok": False, "error": "twitter-cli 75 秒没跑完"})
        except FileNotFoundError:
            self._send(500, {"ok": False, "error": "容器里没有 twitter 命令"})
        except Exception as e:
            print(f"/{cmd} 出错：{type(e).__name__}: {e}", flush=True)
            self._send(502, {"ok": False, "error": f"{type(e).__name__}: {e}"[:400]})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"x sidecar listening on {HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
