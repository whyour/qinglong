FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependency-manifest

WORKDIR /opt/qinglong

COPY deploy/containers/ql3-local-application/package.json ./
COPY deploy/containers/ql3-local-application/package-lock.json ./

FROM dependency-manifest AS build-dependencies

RUN npm ci --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

FROM dependency-manifest AS runtime-dependency-manifest

COPY deploy/containers/ql3-local-application/runtime-dependencies/package.json \
  package.json
COPY deploy/containers/ql3-local-application/runtime-dependencies/package-lock.json \
  package-lock.json

FROM build-dependencies AS workspace

WORKDIR /workspace

COPY packages/ql3-ai packages/ql3-ai
COPY packages/ql3-local-admin packages/ql3-local-admin
COPY packages/ql3-local-application packages/ql3-local-application
COPY packages/ql3-local-command-file packages/ql3-local-command-file
COPY packages/ql3-local-execution packages/ql3-local-execution
COPY packages/ql3-local-process packages/ql3-local-process
COPY packages/ql3-local-secret packages/ql3-local-secret
COPY packages/ql3-local-sqlite packages/ql3-local-sqlite
COPY packages/ql3-runtime-core packages/ql3-runtime-core

RUN ln -s /opt/qinglong/node_modules node_modules \
  && mkdir -p /opt/qinglong/node_modules/@qinglong \
  && ln -s /workspace/packages/ql3-ai \
    /opt/qinglong/node_modules/@qinglong/ai \
  && ln -s /workspace/packages/ql3-local-admin \
    /opt/qinglong/node_modules/@qinglong/local-admin \
  && ln -s /workspace/packages/ql3-local-application \
    /opt/qinglong/node_modules/@qinglong/local-application \
  && ln -s /workspace/packages/ql3-local-command-file \
    /opt/qinglong/node_modules/@qinglong/local-command-file \
  && ln -s /workspace/packages/ql3-local-execution \
    /opt/qinglong/node_modules/@qinglong/local-execution \
  && ln -s /workspace/packages/ql3-local-process \
    /opt/qinglong/node_modules/@qinglong/local-process \
  && ln -s /workspace/packages/ql3-local-secret \
    /opt/qinglong/node_modules/@qinglong/local-secret \
  && ln -s /workspace/packages/ql3-local-sqlite \
    /opt/qinglong/node_modules/@qinglong/local-sqlite \
  && ln -s /workspace/packages/ql3-runtime-core \
    /opt/qinglong/node_modules/@qinglong/runtime-core \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-runtime-core/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-local-command-file/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-local-process/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-local-sqlite/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-ai/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-local-secret/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-local-admin/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-local-execution/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-local-application/tsconfig.json

FROM runtime-dependency-manifest AS external-dependencies

RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

FROM external-dependencies AS assembled

COPY scripts/ql3-prune-runtime-artifact.cjs /tmp/ql3-prune-runtime-artifact.cjs

RUN mkdir -p \
    node_modules/@qinglong/runtime-core \
    node_modules/@qinglong/local-admin \
    node_modules/@qinglong/local-application \
    node_modules/@qinglong/local-command-file \
    node_modules/@qinglong/local-execution \
    node_modules/@qinglong/local-process \
    node_modules/@qinglong/local-secret \
    node_modules/@qinglong/local-sqlite

COPY --from=workspace /workspace/packages/ql3-runtime-core/package.json \
  node_modules/@qinglong/runtime-core/package.json
COPY --from=workspace /workspace/packages/ql3-runtime-core/dist \
  node_modules/@qinglong/runtime-core/dist
COPY --from=workspace /workspace/packages/ql3-local-admin/package.json \
  node_modules/@qinglong/local-admin/package.json
COPY --from=workspace /workspace/packages/ql3-local-admin/dist \
  node_modules/@qinglong/local-admin/dist
COPY --from=workspace /workspace/packages/ql3-local-application/package.json \
  node_modules/@qinglong/local-application/package.json
COPY --from=workspace /workspace/packages/ql3-local-application/dist \
  node_modules/@qinglong/local-application/dist
COPY --from=workspace /workspace/packages/ql3-local-command-file/package.json \
  node_modules/@qinglong/local-command-file/package.json
COPY --from=workspace /workspace/packages/ql3-local-command-file/dist \
  node_modules/@qinglong/local-command-file/dist
COPY --from=workspace /workspace/packages/ql3-local-execution/package.json \
  node_modules/@qinglong/local-execution/package.json
COPY --from=workspace /workspace/packages/ql3-local-execution/dist \
  node_modules/@qinglong/local-execution/dist
COPY --from=workspace /workspace/packages/ql3-local-process/package.json \
  node_modules/@qinglong/local-process/package.json
COPY --from=workspace /workspace/packages/ql3-local-process/dist \
  node_modules/@qinglong/local-process/dist
COPY --from=workspace /workspace/packages/ql3-local-secret/package.json \
  node_modules/@qinglong/local-secret/package.json
COPY --from=workspace /workspace/packages/ql3-local-secret/dist \
  node_modules/@qinglong/local-secret/dist
COPY --from=workspace /workspace/packages/ql3-local-sqlite/package.json \
  node_modules/@qinglong/local-sqlite/package.json
COPY --from=workspace /workspace/packages/ql3-local-sqlite/dist \
  node_modules/@qinglong/local-sqlite/dist

RUN rm -rf node_modules/.bin \
  && node /tmp/ql3-prune-runtime-artifact.cjs node_modules/@qinglong \
    @qinglong/local-application \
    @qinglong/local-application/process \
    @qinglong/local-application/plugin-package-recovery-catalog \
    --exclude=@qinglong/ai \
  && rm /tmp/ql3-prune-runtime-artifact.cjs

FROM node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436 AS runtime

ARG SOURCE_REVISION=uncommitted

LABEL org.opencontainers.image.title="QingLong 3.0 Local Application" \
  org.opencontainers.image.description="QingLong 3.0 AI-excluded Edge and Standalone runtime" \
  org.opencontainers.image.source="https://github.com/whyour/qinglong" \
  org.opencontainers.image.revision="${SOURCE_REVISION}" \
  org.opencontainers.image.licenses="Apache-2.0" \
  org.opencontainers.image.version="3.0.0-alpha.2" \
  io.qinglong.profile="edge,standalone" \
  io.qinglong.ai="excluded" \
  io.qinglong.local.application-config="2,3,4" \
  io.qinglong.local.sqlite-contract-min="51" \
  io.qinglong.local.sqlite-contract-max="52" \
  io.qinglong.local.sqlite-write-contract="52" \
  io.qinglong.local.compose-selection="1"

ENV NODE_ENV=production

WORKDIR /opt/qinglong

COPY --from=assembled --chown=65532:65532 /opt/qinglong ./

USER 65532:65532

ENTRYPOINT ["node", "/opt/qinglong/node_modules/@qinglong/local-application/dist/cli.js"]
