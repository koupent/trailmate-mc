FROM node:22-bookworm-slim

ARG TRAILMATE_VERSION=dev
ENV TRAILMATE_VERSION=${TRAILMATE_VERSION}

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci \
    && npm cache clean --force

COPY tsconfig.json ./
COPY locales ./locales
COPY config.example.json ./config.json
COPY src ./src

CMD ["npm", "start"]
