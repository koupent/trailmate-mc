FROM node:22-bookworm-slim

ARG TRAILMATE_VERSION=dev
ENV TRAILMATE_VERSION=${TRAILMATE_VERSION}
ENV DASHBOARD_VERSION=${TRAILMATE_VERSION}

WORKDIR /app

# docker CLI + compose standalone（更新ジョブ用）
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz \
      | tar -xz -C /tmp \
    && mv /tmp/docker/docker /usr/local/bin/docker \
    && curl -fsSL https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-x86_64 \
      -o /usr/local/bin/docker-compose \
    && chmod +x /usr/local/bin/docker /usr/local/bin/docker-compose \
    && rm -rf /tmp/docker /var/lib/apt/lists/*

COPY package.json ./
COPY server.mjs ./
COPY dockerApi.mjs ./
COPY update.mjs ./
COPY backendReady.mjs ./
COPY public ./public

EXPOSE 8787
CMD ["node", "server.mjs"]
