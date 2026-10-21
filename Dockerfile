# Node 24:package.json 里的 allowScripts(放行 ffmpeg-static 的安装脚本)要 npm 11 才认
FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080
VOLUME /data
CMD ["node", "server.js"]
