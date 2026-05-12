# 直接用 playwright 官方镜像，浏览器与所有 .so 已经齐全
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# 先拷 package.json 利用缓存
COPY package.json ./
RUN npm install --omit=dev

# 再拷源代码
COPY src ./src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8931 \
    HEADLESS=true \
    PXVID_PRIMARY=5 \
    PXVID_SECONDARY=5 \
    PXVID_ACTIVATION_MS=10000

EXPOSE 8931

CMD ["node", "src/server.js"]
