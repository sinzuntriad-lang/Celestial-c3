# Full build (bot + dashboard + Sinzu inbox + media downloader with yt-dlp/ffmpeg).
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates git \
 && pip3 install --break-system-packages -U yt-dlp \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
CMD ["node", "index.js"]
