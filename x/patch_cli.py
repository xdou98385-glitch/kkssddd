"""构建镜像时给 twitter-cli 0.8.5 打一个小补丁（找不到要改的地方就让构建失败，免得悄悄没生效）。

问题：0.8.5 初始化 x-client-transaction-id 时，用【不带登录信息】的请求去取 https://x.com，
而 X 现在的匿名首页里已经没有它要找的 ondemand 脚本，初始化失败（只记一条警告，被吞掉），
之后的搜索请求没有这个头，X 回 HTTP 404。上游多个 issue（#73 #78 #88）都是这个，也有人验证过
「带上登录 cookie 请求 x.com/home 就好」。上游还没发布修复。
补丁：只对 x.com/home 这一次请求带上登录 cookie（和之后的 API 请求同一个域名）；取 ondemand 脚本
那一次（在另一个域名的 CDN 上）仍然不带 cookie，不把登录信息发给别的域名。
"""
import importlib.util
import os
import py_compile
import sys

pkg = os.environ.get("TWITTER_CLI_DIR") or os.path.dirname(importlib.util.find_spec("twitter_cli").origin)
path = os.path.join(pkg, "client.py")
src = open(path, encoding="utf-8").read()

OLD = '''            ct_headers = _gen_ct_headers()
            home_page = cffi_session.get(
                "https://x.com", headers=ct_headers, timeout=10,
            )'''
NEW = '''            ct_headers = _gen_ct_headers()
            # [kkssddd 补丁] 匿名首页已拿不到 ondemand 脚本：带登录 cookie 请求 /home。cookie 只发给 x.com，不发给下面的 CDN
            home_headers = dict(ct_headers)
            home_headers["Cookie"] = self._cookie_string or "auth_token=%s; ct0=%s" % (self._auth_token, self._ct0)
            home_page = cffi_session.get(
                "https://x.com/home", headers=home_headers, timeout=10,
            )'''
if src.count(OLD) != 1:
    sys.exit("补丁目标没找到（出现 %d 次）：twitter-cli 的代码变了，先看 x/patch_cli.py 和上游的修复再决定" % src.count(OLD))
open(path, "w", encoding="utf-8").write(src.replace(OLD, NEW, 1))
py_compile.compile(path, doraise=True)
print("twitter-cli 补丁已应用：", path)
