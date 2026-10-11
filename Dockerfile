# 东秦杀联机中转服务器
#
# 这个服务器**零依赖**，只用 Python 标准库，所以镜像里什么都不用装。
# 它也**不跑游戏逻辑** —— 引擎在房主的浏览器里跑，这里只转发消息、发静态文件。
#
# 本地：
#   docker build -t dqk . && docker run -p 8080:8080 dqk
#   → 打开 http://localhost:8080/
#
# 云平台（Render / Railway / Fly / 任意容器服务）：
#   它们会自己设 PORT 环境变量，server.py 会读它并按平台的端口监听。
#   注意 server.py 在"端口来自环境变量"时**不会顺延端口** —— 平台把流量打到
#   指定的那个端口，顺延等于服务起来了但谁也连不上，所以那种情况它直接报错退出。

FROM python:3.12-alpine

WORKDIR /app
COPY . .

# 本地 docker run 不传 PORT 时的默认值；云平台会覆盖它
ENV PORT=8080
EXPOSE 8080

# -I 是隔离模式：别加载工作目录里的 .py，免得有人往仓库里放个 json.py 之类的东西
CMD ["python", "-I", "server.py"]
