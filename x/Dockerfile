# X（推特，只读）小服务：把 jackwener/twitter-cli（Apache-2.0）当命令行调用。钉死版本，坏了换版本号重建就行。
FROM python:3.12-slim
RUN pip install --no-cache-dir twitter-cli==0.8.5
COPY server.py /app/server.py
WORKDIR /tmp
ENV PYTHONUNBUFFERED=1
EXPOSE 18080
CMD ["python", "/app/server.py"]
