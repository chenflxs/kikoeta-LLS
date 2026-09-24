FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    ADMIN_PORT=2376 \
    API_PORT=2377 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY LICENSE ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME /data
EXPOSE 2376 2377
CMD ["node", "src/server.js"]
