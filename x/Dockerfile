# X（推特，只读）小服务：把 jackwener/twitter-cli（Apache-2.0）当命令行调用。钉死版本，坏了换版本号重建就行。
FROM python:3.12-slim
RUN pip install --no-cache-dir twitter-cli==0.8.5
# 0.8.5 的 ClientTransaction 初始化在 X 现在的匿名首页上失败，导致搜索 HTTP 404；打补丁（找不到目标会让构建失败）
COPY patch_cli.py /tmp/patch_cli.py
RUN python /tmp/patch_cli.py && rm /tmp/patch_cli.py
COPY server.py /app/server.py
WORKDIR /tmp
ENV PYTHONUNBUFFERED=1
EXPOSE 18080
CMD ["python", "/app/server.py"]
