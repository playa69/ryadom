# syntax=docker/dockerfile:1
# agent-api mock for the local stack. It never ships to the cluster.
#   docker build -f dev/agent-mock/Dockerfile -t ryadom-agent-mock dev/agent-mock
FROM node:24-alpine
# espeak-ng gives the mock a real (robotic) Russian voice to stream as TTS frames.
RUN apk add --no-cache espeak-ng
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
ENV PORT=8080
EXPOSE 8080
USER node
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" > /dev/null || exit 1
CMD ["node", "server.mjs"]
