FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependency-manifest

WORKDIR /opt/qinglong

COPY deploy/containers/ql3-local-operator/package.json ./
COPY deploy/containers/ql3-local-operator/package-lock.json ./

FROM dependency-manifest AS build-dependencies

RUN npm ci --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

FROM dependency-manifest AS runtime-dependency-manifest

COPY deploy/containers/ql3-local-operator/runtime-dependencies/package.json \
  package.json
COPY deploy/containers/ql3-local-operator/runtime-dependencies/package-lock.json \
  package-lock.json

FROM build-dependencies AS workspace

WORKDIR /workspace

COPY packages/ql3-ai packages/ql3-ai
COPY packages/ql3-local-admin packages/ql3-local-admin
COPY packages/ql3-local-command-file packages/ql3-local-command-file
COPY packages/ql3-local-owner-cli packages/ql3-local-owner-cli
COPY packages/ql3-local-owner-console packages/ql3-local-owner-console
COPY packages/ql3-local-secret packages/ql3-local-secret
COPY packages/ql3-local-sqlite packages/ql3-local-sqlite
COPY packages/ql3-runtime-core packages/ql3-runtime-core

RUN ln -s /opt/qinglong/node_modules node_modules \
  && mkdir -p /opt/qinglong/node_modules/@qinglong \
  && ln -s /workspace/packages/ql3-ai \
    /opt/qinglong/node_modules/@qinglong/ai \
  && ln -s /workspace/packages/ql3-local-admin \
    /opt/qinglong/node_modules/@qinglong/local-admin \
  && ln -s /workspace/packages/ql3-local-command-file \
    /opt/qinglong/node_modules/@qinglong/local-command-file \
  && ln -s /workspace/packages/ql3-local-owner-cli \
    /opt/qinglong/node_modules/@qinglong/local-owner-cli \
  && ln -s /workspace/packages/ql3-local-owner-console \
    /opt/qinglong/node_modules/@qinglong/local-owner-console \
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
    -p packages/ql3-local-sqlite/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-ai/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-local-secret/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-local-admin/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-local-owner-console/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-local-owner-cli/tsconfig.json

FROM runtime-dependency-manifest AS external-dependencies

RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

FROM external-dependencies AS assembled

RUN mkdir -p \
    node_modules/@qinglong/ai \
    node_modules/@qinglong/local-admin \
    node_modules/@qinglong/local-command-file \
    node_modules/@qinglong/local-owner-cli \
    node_modules/@qinglong/local-owner-console \
    node_modules/@qinglong/local-secret \
    node_modules/@qinglong/local-sqlite \
    node_modules/@qinglong/runtime-core

COPY --from=workspace /workspace/packages/ql3-ai/package.json \
  node_modules/@qinglong/ai/package.json
COPY --from=workspace /workspace/packages/ql3-ai/dist \
  node_modules/@qinglong/ai/dist
COPY --from=workspace /workspace/packages/ql3-local-admin/package.json \
  node_modules/@qinglong/local-admin/package.json
COPY --from=workspace /workspace/packages/ql3-local-admin/dist \
  node_modules/@qinglong/local-admin/dist
COPY --from=workspace /workspace/packages/ql3-local-command-file/package.json \
  node_modules/@qinglong/local-command-file/package.json
COPY --from=workspace /workspace/packages/ql3-local-command-file/dist \
  node_modules/@qinglong/local-command-file/dist
COPY --from=workspace /workspace/packages/ql3-local-owner-cli/package.json \
  node_modules/@qinglong/local-owner-cli/package.json
COPY --from=workspace /workspace/packages/ql3-local-owner-cli/dist \
  node_modules/@qinglong/local-owner-cli/dist
COPY --from=workspace /workspace/packages/ql3-local-owner-console/package.json \
  node_modules/@qinglong/local-owner-console/package.json
COPY --from=workspace /workspace/packages/ql3-local-owner-console/dist \
  node_modules/@qinglong/local-owner-console/dist
COPY --from=workspace /workspace/packages/ql3-local-secret/package.json \
  node_modules/@qinglong/local-secret/package.json
COPY --from=workspace /workspace/packages/ql3-local-secret/dist \
  node_modules/@qinglong/local-secret/dist
COPY --from=workspace /workspace/packages/ql3-local-sqlite/package.json \
  node_modules/@qinglong/local-sqlite/package.json
COPY --from=workspace /workspace/packages/ql3-local-sqlite/dist \
  node_modules/@qinglong/local-sqlite/dist
COPY --from=workspace /workspace/packages/ql3-runtime-core/package.json \
  node_modules/@qinglong/runtime-core/package.json
COPY --from=workspace /workspace/packages/ql3-runtime-core/dist \
  node_modules/@qinglong/runtime-core/dist

RUN rm -rf node_modules/.bin \
  && find node_modules/@qinglong -type f \
    \( -name '*.d.ts' -o -name '*.map' \) -delete \
  && find node_modules/@qinglong -type f -name '*.js' -exec \
    sed -i '/^\/\/# sourceMappingURL=[A-Za-z0-9_.-]*\.map$/d' {} +

FROM node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436 AS runtime

RUN apk add --no-cache --upgrade \
    docker-cli=29.5.2-r0 \
    libcrypto3=3.5.8-r0 \
    libssl3=3.5.8-r0

ARG SOURCE_REVISION=uncommitted

LABEL org.opencontainers.image.title="QingLong 3.0 Local Operator" \
  org.opencontainers.image.description="QingLong 3.0 short-lived Local management authority" \
  org.opencontainers.image.source="https://github.com/whyour/qinglong" \
  org.opencontainers.image.revision="${SOURCE_REVISION}" \
  org.opencontainers.image.licenses="Apache-2.0" \
  org.opencontainers.image.version="3.0.0-alpha.2" \
  io.qinglong.lifecycle="short-lived" \
  io.qinglong.authority="local-owner-management" \
  io.qinglong.network="none-by-default"

ENV NODE_ENV=production

WORKDIR /opt/qinglong

COPY --from=assembled --chown=65532:65532 /opt/qinglong ./

USER 65532:65532

ENTRYPOINT ["node", "/opt/qinglong/node_modules/@qinglong/local-owner-cli/dist/product-cli/cli.js"]
