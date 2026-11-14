# 只跑 HTTP 部分的话不需要浏览器；用浏览器通道时它已经在镜像里
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates chromium ffmpeg fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖，利用镜像层缓存
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV NODE_ENV=production \
    BROWSER_EXECUTABLE=/usr/bin/chromium \
    BROWSER_HEADLESS=true \
    PORT=8788

EXPOSE 8788

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:8788/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/cli.mjs", "--serve"]
