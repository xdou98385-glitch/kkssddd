"""抖音（只读）小服务。把 cv-cat/DouYin_Spider 里「看」的那几个接口包成几个本机 HTTP 接口，给聊天网站的 Claude 用。

- 读：推荐流、搜索、作品详情 + 评论、点赞列表、收藏夹、关注/粉丝、通知、听新私信。
- 写（聊天网站那边有总开关和确认）：点赞、收藏、发私信。发评论要浏览器票据（creds）。发布作品没接。
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


def parse_creds(raw) -> dict:
    """浏览器 localStorage 里 security-sdk 的两项 → 票据四件套。
    raw 是 {键名: 值} 的字典（控制台脚本打包出来的）。键名只按后缀认，认不出就把看到的键名（不含值）报回去。"""
    if isinstance(raw, str):
        raw = json.loads(raw)
    if not isinstance(raw, dict) or not raw:
        return {}
    out = {}
    if raw.get("dtrait_blob"):
        out["dtrait_blob"] = str(raw["dtrait_blob"]).strip()
    wp = next((v for k, v in raw.items() if k.endswith("web_protect")), None)
    ck = next((v for k, v in raw.items() if "crypt_sdk" in k), None)
    if wp is None and ck is None:
        if out:
            return out  # 只有设备特征（点赞/收藏够用）
        raise ValueError("浏览器凭据里缺东西。我看到的键名：" + "、".join(sorted(k for k in raw.keys() if k != "dtrait_blob"))[:300])
    if wp is None or ck is None:
        raise ValueError("浏览器凭据里缺一半。我看到的键名：" + "、".join(sorted(raw.keys()))[:300])
    p = json.loads(json.loads(wp)["data"])
    k = json.loads(json.loads(ck)["data"])
    out.update(ticket=p["ticket"], ts_sign=p["ts_sign"], client_cert=p["client_cert"], private_key=k["ec_privateKey"])
    return out


def get_auth(cookie: str, creds=None) -> DouyinAuth:
    cookie = (cookie or "").strip()
    if not cookie:
        raise ValueError("没有 cookie")
    extra = parse_creds(creds) if creds else {}
    key = hashlib.sha256((cookie + json.dumps(extra, sort_keys=True)).encode()).hexdigest()
    hit = AUTHS.get(key)
    if hit and time.time() - hit[1] < AUTH_TTL:
        return hit[0]
    AUTHS.clear()  # 只留当前这一个，换了 cookie 旧的就丢
    auth = DouyinAuth.open(cookie, login_type="cookie", bootstrap_creator=False, **extra)
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


SESSION_KEYS = ("sessionid", "sessionid_ss", "sid_tt", "sid_guard", "uid_tt")


def has_session(auth) -> bool:
    """cookie 里有没有登录凭据。游客 cookie 也能读推荐流，但搜索/点赞/评论都会被拒，所以单独查"""
    ck = getattr(auth, "cookie", None) or {}
    return any(k in ck for k in SESSION_KEYS[:4])


NOT_LOGGED_IN = "这份 cookie 里没有登录凭据（sessionid / sid_guard 都没有），是游客 cookie：能看推荐流，但搜索、点赞、评论都不行。请在【已登录】的抖音网页里重新取一次 cookie"


def whoami(auth, body):
    uid = DouyinAPI.get_my_uid(auth)
    sec = DouyinAPI.get_my_sec_uid(auth)
    out = {"uid": uid, "sec_uid": sec, "has_session": has_session(auth)}
    try:
        info = (DouyinAPI.get_user_info(auth, f"https://www.douyin.com/user/{sec}") or {}).get("user") or {}
        out.update(nickname=info.get("nickname"), followers=info.get("follower_count"), following=info.get("following_count"), works=info.get("aweme_count"))
    except Exception as e:  # 昵称读不到不影响「登录有效」这个结论
        out["note"] = f"用户资料没读到：{e}"[:200]
    return out


def feed_v2(auth, n: int) -> dict:
    """浏览器现在用的推荐流：POST /aweme/v2/web/module/feed/（2026-10 她的浏览器抓包）。
    项目库里只有旧的 v1 GET；这里照浏览器的参数自己拼一个，签名、请求头仍用库里的现成部件。"""
    from builder.header import HeaderBuilder, HeaderType
    from builder.params import Params
    from utils import http_client as http
    from dy_apis.douyin_api import check_risk_response

    refer = "https://www.douyin.com/"
    headers = HeaderBuilder().build(HeaderType.FORM)
    headers.set_referer(refer)
    headers.with_uifid(auth)
    headers.set_header("origin", "https://www.douyin.com")
    params = Params()
    params.with_platform(round_trip_time="100")
    for k, v in [
        ("module_id", "3003101"), ("count", str(n)), ("filterGids", ""), ("presented_ids", ""),
        ("refresh_index", "5"), ("refer_id", ""), ("refer_type", "10"), ("pull_type", "2"),
        ("awemePcRecRawData", '{"is_xigua_user":0,"danmaku_switch_status":0,"is_client":false}'),
        ("Seo-Flag", "0"), ("install_time", str(int(time.time()) - 3600)), ("tag_id", ""), ("active_id", ""),
        ("is_active_tab", "false"), ("use_lite_type", "0"), ("xigua_user", "0"),
    ]:
        params.add_param(k, v)
    params.with_web_id(auth, refer)
    params.with_uifid(auth)
    params.with_verify_fp(auth)
    params.add_param("msToken", auth.msToken)
    params.with_a_bogus()
    res = http.post("https://www.douyin.com/aweme/v2/web/module/feed/", headers=headers.get(), params=params.get(),
                    cookies=auth.cookie, data="", verify=False)
    check_risk_response(res)
    return res.json()


def read_feed(auth, n: int):
    """先试旧接口 v1，不行（报错或空）再试浏览器现在用的 v2。返回 (items, 用了哪个, 失败原因们)"""
    errs = []
    for name, fn in (("v1", lambda: DouyinAPI.get_feed(auth, count=str(n))), ("v2", lambda: feed_v2(auth, n))):
        try:
            d = fn()
            items = [brief(a) for a in awemes_from(d)][:n]
            if items:
                return items, name, errs
            errs.append(f"{name}：返回里没有作品（字段：{','.join(sorted(d.keys())[:10])}）")
        except Exception as e:
            errs.append(f"{name}：{type(e).__name__}: {e}"[:300])
    return [], None, errs


def feed(auth, body):
    n = max(1, min(int(body.get("count") or 12), 20))
    items, via, errs = read_feed(auth, n)
    if not items:
        raise RuntimeError("推荐流读不出来。" + " | ".join(errs))
    return {"items": items, "via": via}


def probe(auth, body):
    """体检：把每个只读功能各试一遍，告诉她哪些通、哪些不通、为什么"""
    out = {}

    def run(name, fn):
        try:
            out[name] = {"ok": True, **fn()}
        except Exception as e:
            out[name] = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
        time.sleep(1.5)

    if has_session(auth):
        run("whoami", lambda: {"n": 1})
    else:
        out["whoami"] = {"ok": False, "error": NOT_LOGGED_IN}
    items, via, errs = read_feed(auth, 3)
    out["feed"] = {"ok": bool(items), "n": len(items), "via": via, "error": " | ".join(errs) if not items else None}
    time.sleep(1.5)
    run("search", lambda: {"n": len(search(auth, {"query": "猫", "count": 2})["items"])})
    run("likes", lambda: {"n": len(likes(auth, {"count": 2})["items"])})
    return out


def search(auth, body):
    q = str(body.get("query") or "").strip()
    if not q:
        raise ValueError("没有搜索词")
    n = max(1, min(int(body.get("count") or 10), 20))
    sort = {"综合": "0", "最多点赞": "1", "最新": "2"}.get(str(body.get("sort") or "综合"), "0")
    d = DouyinAPI.search_general_work(auth, q, sort, "0", "0")
    if "data" not in d:  # 被拒时没有 data：把抖音说的原因带回来，别只报 KeyError
        extra = {k: d.get(k) for k in ("status_code", "status_msg", "search_nil_info") if d.get(k) not in (None, "")}
        raise RuntimeError(f"搜索被拒：{json.dumps(extra, ensure_ascii=False)[:250]}（字段：{','.join(sorted(d.keys())[:10])}）")
    return {"items": [brief(w["aweme_info"]) for w in d["data"] if w.get("aweme_info")][:n]}


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


# ---------- 更多只读 ----------
def user_brief(u: dict) -> dict:
    return {
        "uid": u.get("uid"), "sec_uid": u.get("sec_uid"), "nickname": u.get("nickname"),
        "signature": (u.get("signature") or "")[:80], "followers": u.get("follower_count"),
        "works": u.get("aweme_count"),
    }


def _me(auth):
    return str(DouyinAPI.get_my_uid(auth)), DouyinAPI.get_my_sec_uid(auth)


def followers(auth, body):
    n = max(1, min(int(body.get("count") or 20), 40))
    uid, sec = _me(auth)
    return {"items": [user_brief(u) for u in DouyinAPI.get_some_user_follower_list(auth, uid, sec, n)]}


def following(auth, body):
    n = max(1, min(int(body.get("count") or 20), 40))
    uid, sec = _me(auth)
    return {"items": [user_brief(u) for u in DouyinAPI.get_some_user_following_list(auth, uid, sec, n)]}


def collects(auth, body):
    d = DouyinAPI.get_collect_list(auth)
    lst = d.get("collects_list") or d.get("collect_list") or []
    return {"items": [{"id": c.get("collects_id"), "name": c.get("collects_name"), "count": c.get("item_total_number") or c.get("total_number")} for c in lst][:30],
            "keys": sorted(d.keys())[:12] if not lst else None}


def _flat_text(x, out, depth=0):
    """通知的结构我没见过真的，递归捞出昵称和文字，捞不到就留原样"""
    if depth > 4:
        return
    if isinstance(x, dict):
        for k in ("nickname", "text", "content", "title", "desc"):
            v = x.get(k)
            if isinstance(v, str) and v.strip():
                out.append(v.strip())
        for v in x.values():
            if isinstance(v, (dict, list)):
                _flat_text(v, out, depth + 1)
    elif isinstance(x, list):
        for v in x[:5]:
            _flat_text(v, out, depth + 1)


def notices(auth, body):
    n = max(1, min(int(body.get("count") or 15), 30))
    group = {"全部": "700", "粉丝": "401", "艾特": "601", "评论": "2", "点赞": "3"}.get(str(body.get("group") or "全部"), "700")
    items = []
    for it in DouyinAPI.get_some_notice_list(auth, n, group):
        parts: list = []
        _flat_text(it, parts)
        seen, uniq = set(), []
        for t in parts:
            if t not in seen:
                seen.add(t)
                uniq.append(t)
        items.append({"type": it.get("type"), "time": it.get("create_time"), "text": " / ".join(uniq)[:200] or json.dumps(it, ensure_ascii=False)[:200]})
    return {"items": items[:n]}


def comments(auth, body):
    ref = str(body.get("id") or "").strip()
    if not ref:
        raise ValueError("没有作品 id")
    url = f"https://www.douyin.com/video/{ref}"
    cd = DouyinAPI.get_work_out_comment(auth, url, str(body.get("cursor") or "0"))
    out = []
    for c in (cd.get("comments") or [])[: max(1, min(int(body.get("count") or 15), 30))]:
        row = {"cid": c.get("cid"), "user": (c.get("user") or {}).get("nickname"), "text": c.get("text"),
               "digg": c.get("digg_count"), "replies_total": c.get("reply_comment_total"), "replies": []}
        if body.get("with_replies") and (c.get("reply_comment_total") or 0) > 0 and len([r for r in out if r["replies"]]) < 3:
            try:
                rd = DouyinAPI.get_work_inner_comment(auth, c, "0", "5")
                row["replies"] = [{"user": (r.get("user") or {}).get("nickname"), "text": r.get("text")} for r in (rd.get("comments") or [])][:5]
            except Exception as e:
                row["replies"] = [{"user": None, "text": f"（回复没取到：{e}）"[:100]}]
        out.append(row)
    return {"items": out, "cursor": cd.get("cursor"), "has_more": cd.get("has_more")}


# ---------- 轻量写：点赞 / 收藏 ----------
def digg(auth, body):
    ok = DouyinAPI.digg(auth, str(body["id"]), "0" if body.get("undo") else "1")
    if not ok:
        raise RuntimeError("抖音没接受这次点赞（status_code 非 0）")
    return {"done": True}


def collect(auth, body):
    d = DouyinAPI.collect_aweme(auth, str(body["id"]), "0" if body.get("undo") else "1")
    if d.get("status_code") != 0:
        raise RuntimeError(f"抖音没接受这次收藏（status_code={d.get('status_code')}）")
    return {"done": True}


# ---------- 评论（要浏览器票据） ----------
def comment_post(auth, body):
    text = str(body["text"]).strip()
    if not text:
        raise ValueError("评论内容是空的")
    r = DouyinAPI.publish_comment(auth, str(body["id"]), text, str(body.get("reply_id") or ""))
    if r.get("status_code") != 0:
        detail = json.dumps({k: v for k, v in r.items() if k != "comment"}, ensure_ascii=False)[:350]
        print(f"评论被拒：{detail}", flush=True)
        raise RuntimeError(f"抖音没接受这条评论。完整回应：{detail}")
    return {"done": True}


# ---------- 私信 ----------
def dm_send(auth, body):
    to = int(body["to_uid"])
    text = str(body["text"]).strip()
    if not text:
        raise ValueError("私信内容是空的")
    cid, short_id, ticket = DouyinAPI.create_conversation(auth, to)
    if not DouyinAPI.send_msg(auth, cid, short_id, ticket, text):
        raise RuntimeError("私信发送没成功（抖音没回 OK，详见 docker compose logs douyin）")
    return {"done": True}


def dm_recv(auth, body):
    """连上私信的 WebSocket 听一小会儿，收这段时间进来的新私信（接口只推送，看不到历史）"""
    import websocket as _ws
    from dy_apis.douyin_recv_msg import DouyinRecvMsg
    from static import Live_pb2, Response_pb2

    secs = max(3, min(int(body.get("seconds") or 12), 30))
    got: list = []
    rm = DouyinRecvMsg(auth, auto_reconnect=False)

    def on_message(ws, message):
        try:
            frame = Live_pb2.PushFrame()
            frame.ParseFromString(message)
            if frame.payloadType != "pb":
                return
            resp = Response_pb2.Response()
            resp.ParseFromString(frame.payload)
            m = resp.body.new_message_notify.message
            if not m.conversation_id:
                return
            c = json.loads(m.content or "{}")
            t = m.message_type
            text = c.get("text") if t == 7 else {5: "[表情包]", 17: "[语音]", 27: "[图片]"}.get(t) or (f"[分享了视频 {c.get('itemId')}]" if t == 8 else None)
            if text:
                got.append({"from": m.sender, "text": text, "conversation": m.conversation_id})
        except Exception:
            pass

    ws = _ws.WebSocketApp(rm.url, on_message=on_message, on_open=rm.on_open)
    th = threading.Thread(target=lambda: ws.run_forever(), daemon=True)
    th.start()
    time.sleep(secs)
    ws.close()
    th.join(3)
    return {"items": got, "listened": secs}


ROUTES = {"/whoami": whoami, "/feed": feed, "/search": search, "/work": work, "/likes": likes, "/probe": probe,
          "/followers": followers, "/following": following, "/collects": collects, "/notices": notices, "/comments": comments,
          "/comment_post": comment_post, "/digg": digg, "/collect": collect, "/dm_send": dm_send, "/dm_recv": dm_recv}


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
                data = fn(get_auth(body.get("cookie"), body.get("creds")), body)
            self._send(200, {"ok": True, "data": data})
        except Exception as e:  # 风控、cookie 失效、接口改了……都原样把原因带回去，别吞
            print(f"{self.path} 出错：{type(e).__name__}: {e}", flush=True)
            self._send(502, {"ok": False, "error": f"{type(e).__name__}: {e}"[:400]})

    def log_message(self, fmt, *args):  # 不打印请求行（里面没有 cookie，但也没必要）
        pass


if __name__ == "__main__":
    print(f"douyin sidecar listening on {HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
