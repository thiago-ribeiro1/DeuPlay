# --- deps: instala apenas dependencias de producao, aproveitando cache ---
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# --- runtime: imagem final, com FFmpeg/ffprobe e usuario nao-root ---
FROM node:20-alpine AS runtime
RUN apk add --no-cache ffmpeg wget \
  && addgroup -S iptv && adduser -S iptv -G iptv

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    MEDIA_ROOT=/app/media \
    FFMPEG_PATH=ffmpeg \
    FFPROBE_PATH=ffprobe

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /app/media/streams && chown -R iptv:iptv /app
VOLUME ["/app/media"]

USER iptv
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health | grep -q '"status"' || exit 1

CMD ["node", "server/app.js"]
