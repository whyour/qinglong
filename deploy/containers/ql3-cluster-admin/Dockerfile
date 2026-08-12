FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependency-manifest

WORKDIR /opt/qinglong

COPY deploy/containers/ql3-cluster-admin/package.json ./
COPY deploy/containers/ql3-cluster-admin/package-lock.json ./

FROM dependency-manifest AS build-dependencies

RUN npm ci --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

FROM dependency-manifest AS runtime-dependency-manifest

COPY deploy/containers/ql3-cluster-admin/runtime-dependencies/package.json \
  package.json
COPY deploy/containers/ql3-cluster-admin/runtime-dependencies/package-lock.json \
  package-lock.json

FROM build-dependencies AS workspace

WORKDIR /workspace

COPY packages/ql3-runtime-core packages/ql3-runtime-core
COPY packages/ql3-ai packages/ql3-ai
COPY packages/ql3-cluster-postgres packages/ql3-cluster-postgres
COPY packages/ql3-cluster-admin packages/ql3-cluster-admin

RUN ln -s /opt/qinglong/node_modules node_modules \
  && mkdir -p /opt/qinglong/node_modules/@qinglong \
  && ln -s /workspace/packages/ql3-runtime-core \
    /opt/qinglong/node_modules/@qinglong/runtime-core \
  && ln -s /workspace/packages/ql3-ai \
    /opt/qinglong/node_modules/@qinglong/ai \
  && ln -s /workspace/packages/ql3-cluster-postgres \
    /opt/qinglong/node_modules/@qinglong/cluster-postgres \
  && ln -s /workspace/packages/ql3-cluster-admin \
    /opt/qinglong/node_modules/@qinglong/cluster-admin \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-runtime-core/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-ai/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-cluster-postgres/tsconfig.json \
  && /opt/qinglong/node_modules/.bin/tsc \
    -p packages/ql3-cluster-admin/tsconfig.json

FROM runtime-dependency-manifest AS external-dependencies

RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

FROM external-dependencies AS assembled

RUN mkdir -p \
    node_modules/@qinglong/runtime-core \
    node_modules/@qinglong/ai \
    node_modules/@qinglong/cluster-postgres \
    node_modules/@qinglong/cluster-admin

COPY --from=workspace /workspace/packages/ql3-runtime-core/package.json \
  node_modules/@qinglong/runtime-core/package.json
COPY --from=workspace /workspace/packages/ql3-runtime-core/dist \
  node_modules/@qinglong/runtime-core/dist
COPY --from=workspace /workspace/packages/ql3-ai/package.json \
  node_modules/@qinglong/ai/package.json
COPY --from=workspace /workspace/packages/ql3-ai/dist \
  node_modules/@qinglong/ai/dist
COPY --from=workspace /workspace/packages/ql3-cluster-postgres/package.json \
  node_modules/@qinglong/cluster-postgres/package.json
COPY --from=workspace /workspace/packages/ql3-cluster-postgres/dist \
  node_modules/@qinglong/cluster-postgres/dist
COPY --from=workspace /workspace/packages/ql3-cluster-admin/package.json \
  node_modules/@qinglong/cluster-admin/package.json
COPY --from=workspace /workspace/packages/ql3-cluster-admin/dist \
  node_modules/@qinglong/cluster-admin/dist

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

ARG SOURCE_REVISION=uncommitted

LABEL org.opencontainers.image.title="QingLong 3.0 Cluster Admin" \
  org.opencontainers.image.description="QingLong 3.0 short-lived cluster administration jobs" \
  org.opencontainers.image.source="https://github.com/whyour/qinglong" \
  org.opencontainers.image.revision="${SOURCE_REVISION}" \
  org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production

WORKDIR /opt/qinglong

COPY --from=assembled --chown=10001:10001 /opt/qinglong ./

USER 10001:10001

ENTRYPOINT ["node", "/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/product-cli/cli.js"]
