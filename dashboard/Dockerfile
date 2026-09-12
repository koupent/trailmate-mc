FROM node:22-bookworm-slim

WORKDIR /app

# docker CLI for ViaProxy account login / logs
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz \
      | tar -xz -C /tmp \
    && mv /tmp/docker/docker /usr/local/bin/docker \
    && rm -rf /tmp/docker /var/lib/apt/lists/*

COPY package.json ./
COPY server.mjs ./
COPY dockerApi.mjs ./
COPY public ./public

EXPOSE 8787
CMD ["node", "server.mjs"]
