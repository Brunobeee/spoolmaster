FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3420 \
    SPOOLMASTER_DB=/data/spoolmaster.db \
    TZ=Europe/Prague

RUN apk add --no-cache tzdata

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Všechny moduly serveru (nový .js soubor v kořeni se tak nezapomene přidat).
COPY *.js ./
COPY public ./public

# Běží jako root kvůli právům na připojené složky NASu (UGOS je vytváří pod svým uživatelem).
VOLUME /data
EXPOSE 3420
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "server.js"]
