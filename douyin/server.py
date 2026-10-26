"""抖音（只读）小服务。把 cv-cat/DouYin_Spider 里「看」的那几个接口包成几个本机 HTTP 接口，给聊天网站的 Claude 用。

- 只做读：推荐流、搜索、一个作品的详情 + 热门评论、她自己「喜欢」的列表。点赞/评论/私信/发布一概不接。
- cookie 不存在这里：每次请求由聊天网站带过来（只在本机回环地址上走），这个服务自己什么都不落盘。
- 一次只处理一个请求（锁），避免短时间内连着打抖音。
"""
import hashlib
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 注意顺序：必须先导入 dy_apis，再导入 builder.auth（两边互相引用，反过来会循环导入报错）
from dy_apis.douyin_api import DouyinAPI
from builder.auth import DouyinAuth

PORT = int(os.environ.get("PORT", "18070"))
HOST = os.environ.get("HOST", "0.0.0.0")  # 容器里要监听全部网卡，对外只由 docker 绑到 127.0.0.1
LOCK = threading.Lock()
AUTHS: dict[str, tuple[DouyinAuth, float]] = {}
AUTH_TTL = 30 * 60


def get_auth(cookie: str) -> DouyinAuth:
    cookie = (cookie or "").strip()
    if not cookie:
        raise ValueError("没有 cookie")
    key = hashlib.sha256(cookie.encode()).hexdigest()
    hit = AUTHS.get(key)
    if hit and time.time() - hit[1] < AUTH_TTL:
        return hit[0]
    AUTHS.clear()  # 只留当前这一个，换了 cookie 旧的就丢
    auth = DouyinAuth.open(cookie, login_type="cookie", bootstrap_creator=False)
    AUTHS[key] = (auth, time.time())
    return auth


def brief(a: dict) -> dict:
    st = a.get("statistics") or {}
    au = a.get("author") or {}
    aid = a.get("aweme_id") or a.get("group_id")
    return {
        "id": aid,
        "url": f"https://www.douyin.com/video/{aid}" if aid else None,
        "desc": a.get("desc") or "",
        "author": au.get("nickname"),
        "digg": st.get("digg_count"),
        "comment": st.get("comment_count"),
        "collect": st.get("collect_count"),
        "share": st.get("share_count"),
        "time": a.get("create_time"),
        "topics": [t.get("hashtag_name") for t in (a.get("text_extra") or []) if t.get("hashtag_name")],
        "kind": "图集" if a.get("aweme_type") == 68 else "视频",
        "seconds": round(((a.get("video") or {}).get("duration") or 0) / 1000) or None,
    }


def awemes_from(d: dict) -> list:
    lst = list(d.get("aweme_list") or [])
    if not lst:
        for x in d.get("data") or []:
            a = x.get("aweme") or x.get("aweme_info") or (x if "aweme_id" in x else None)
            if a:
                lst.append(a)
    return lst


def whoami(auth, body):
    uid = DouyinAPI.get_my_uid(auth)
    sec = DouyinAPI.get_my_sec_uid(auth)
    out = {"uid": uid, "sec_uid": sec}
    try:
        info = (DouyinAPI.get_user_info(auth, f"https://www.douyin.com/user/{sec}") or {}).get("user") or {}
        out.update(nickname=info.get("nickname"), followers=info.get("follower_count"), following=info.get("following_count"), works=info.get("aweme_count"))
    except Exception as e:  # 昵称读不到不影响「登录有效」这个结论
        out["note"] = f"用户资料没读到：{e}"[:200]
    return out


def feed(auth, body):
    n = max(1, min(int(body.get("count") or 12), 20))
    d = DouyinAPI.get_feed(auth, count=str(n))
    items = [brief(a) for a in awemes_from(d)][:n]
    return {"items": items, "keys": sorted(d.keys())[:12] if not items else None}


def search(auth, body):
    q = str(body.get("query") or "").strip()
    if not q:
        raise ValueError("没有搜索词")
    n = max(1, min(int(body.get("count") or 10), 20))
    sort = {"综合": "0", "最多点赞": "1", "最新": "2"}.get(str(body.get("sort") or "综合"), "0")
    works = DouyinAPI.search_some_general_work(auth, q, n, sort, "0")
    return {"items": [brief(w["aweme_info"]) for w in works if w.get("aweme_info")][:n]}


def work(auth, body):
    ref = str(body.get("id") or body.get("url") or "").strip()
    if not ref:
        raise ValueError("没有作品 id")
    url = ref if ref.startswith("http") else f"https://www.douyin.com/video/{ref}"
    d = DouyinAPI.get_work_info(auth, url)
    detail = d.get("aweme_detail")
    if not detail:
        return {"item": None, "note": "没取到这个作品（可能已删除、仅自己可见，或被风控）", "keys": sorted(d.keys())[:12]}
    comments = []
    try:
        cd = DouyinAPI.get_work_out_comment(auth, url, "0")
        for c in (cd.get("comments") or [])[:10]:
            comments.append({
                "user": (c.get("user") or {}).get("nickname"),
                "text": c.get("text"),
                "digg": c.get("digg_count"),
                "replies": c.get("reply_comment_total"),
            })
    except Exception as e:
        comments = [{"user": None, "text": f"（评论没取到：{e}）"[:200], "digg": None, "replies": None}]
    return {"item": brief(detail), "comments": comments}


def likes(auth, body):
    n = max(1, min(int(body.get("count") or 12), 20))
    sec = DouyinAPI.get_my_sec_uid(auth)
    d = DouyinAPI.get_user_favorite(auth, sec, "0", str(n))
    return {"items": [brief(a) for a in awemes_from(d)][:n]}


ROUTES = {"/whoami": whoami, "/feed": feed, "/search": search, "/work": work, "/likes": likes}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, obj: dict):
        raw = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True})
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        fn = ROUTES.get(self.path)
        if not fn:
            return self._send(404, {"ok": False, "error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except Exception:
            return self._send(400, {"ok": False, "error": "请求体不是 JSON"})
        try:
            with LOCK:
                data = fn(get_auth(body.get("cookie")), body)
            self._send(200, {"ok": True, "data": data})
        except Exception as e:  # 风控、cookie 失效、接口改了……都原样把原因带回去，别吞
            print(f"{self.path} 出错：{type(e).__name__}: {e}", flush=True)
            self._send(502, {"ok": False, "error": f"{type(e).__name__}: {e}"[:400]})

    def log_message(self, fmt, *args):  # 不打印请求行（里面没有 cookie，但也没必要）
        pass


if __name__ == "__main__":
    print(f"douyin sidecar listening on {HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
