# 抖音（只读）小服务。不把 DouYin_Spider 的代码放进本仓库（它没有许可证文件），构建时从 GitHub 拉，钉在我读过、测过的那个提交上。
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ARG SPIDER_REF=d151f9c2980abc304c1ae4918c2272675cd9e4c2
RUN git init /app/spider && cd /app/spider \
 && git remote add origin https://github.com/cv-cat/DouYin_Spider \
 && git fetch --depth 1 origin ${SPIDER_REF} && git checkout FETCH_HEAD
WORKDIR /app/spider
# blackboxprotobuf 声明依赖 protobuf==3.10，会和项目需要的 protobuf>=5.27 打架；按项目自己的说明，先装别的，再单独 --no-deps 装它
RUN grep -v '^blackboxprotobuf' requirements.txt > /tmp/req.txt \
 && pip install --no-cache-dir -r /tmp/req.txt \
 && pip install --no-cache-dir --no-deps blackboxprotobuf
COPY server.py /app/server.py
ENV PYTHONPATH=/app/spider PYTHONUNBUFFERED=1
EXPOSE 18070
CMD ["python", "/app/server.py"]
