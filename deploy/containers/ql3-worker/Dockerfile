FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependency-manifest

WORKDIR /opt/qinglong

COPY deploy/containers/ql3-worker/package.json ./
COPY deploy/containers/ql3-worker/package-lock.json ./

FROM dependency-manifest AS build-dependencies

RUN npm ci --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

FROM dependency-manifest AS runtime-dependency-manifest

COPY deploy/containers/ql3-worker/runtime-dependencies/package.json \
  package.json
COPY deploy/containers/ql3-worker/runtime-dependencies/package-lock.json \
  package-lock.json

FROM build-dependencies AS workspace

WORKDIR /workspace

COPY packages/ql3-runtime-core packages/ql3-runtime-core
COPY packages/ql3-local-process packages/ql3-local-process
COPY packages/ql3-worker-runtime packages/ql3-worker-runtime

RUN ln -s /opt/qinglong/node_modules node_modules \
  && mkdir -p /opt/qinglong/node_modules/@qinglong \
  && ln -s /workspace/packages/ql3-runtime-core \
    /opt/qinglong/node_modules/@qinglong/runtime-core \
  && ln -s /workspace/packages/ql3-local-process \
    /opt/qinglong/node_modules/@qinglong/local-process \
  && ln -s /workspace/packages/ql3-worker-runtime \
    /opt/qinglong/node_modules/@qinglong/worker-runtime \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-runtime-core/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-local-process/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-worker-runtime/tsconfig.json

FROM runtime-dependency-manifest AS external-dependencies

RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

FROM external-dependencies AS assembled

RUN mkdir -p \
    node_modules/@qinglong/runtime-core \
    node_modules/@qinglong/local-process \
    node_modules/@qinglong/worker-runtime

COPY --from=workspace /workspace/packages/ql3-runtime-core/package.json \
  node_modules/@qinglong/runtime-core/package.json
COPY --from=workspace /workspace/packages/ql3-runtime-core/dist \
  node_modules/@qinglong/runtime-core/dist
COPY --from=workspace /workspace/packages/ql3-local-process/package.json \
  node_modules/@qinglong/local-process/package.json
COPY --from=workspace /workspace/packages/ql3-local-process/dist \
  node_modules/@qinglong/local-process/dist
COPY --from=workspace /workspace/packages/ql3-local-process/assets \
  node_modules/@qinglong/local-process/assets
COPY --from=workspace /workspace/packages/ql3-worker-runtime/package.json \
  node_modules/@qinglong/worker-runtime/package.json
COPY --from=workspace /workspace/packages/ql3-worker-runtime/dist \
  node_modules/@qinglong/worker-runtime/dist

RUN chmod 0555 \
    node_modules/@qinglong/local-process/assets/ql3-launcher.sh \
  && rm -rf node_modules/.bin \
  && find node_modules/@qinglong -type f -name '*.map' -delete

FROM node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436 AS runtime

ARG SOURCE_REVISION=uncommitted

LABEL org.opencontainers.image.title="QingLong 3.0 Worker" \
  org.opencontainers.image.description="QingLong 3.0 headless Remote Worker runtime" \
  org.opencontainers.image.source="https://github.com/whyour/qinglong" \
  org.opencontainers.image.revision="${SOURCE_REVISION}" \
  org.opencontainers.image.licenses="Apache-2.0" \
  org.opencontainers.image.version="3.0.0-alpha.1" \
  io.qinglong.profile="worker" \
  io.qinglong.worker.capacity-profiles="edge,node"

ENV NODE_ENV=production

WORKDIR /opt/qinglong

COPY --from=assembled --chown=65532:65532 /opt/qinglong ./

USER 65532:65532

ENTRYPOINT ["node", "/opt/qinglong/node_modules/@qinglong/worker-runtime/dist/process/workerProcessCli.js"]
