# Test runtime only: never used as the CLI's distribution or panel image.
FROM node:22.12.0-bookworm-slim@sha256:35531c52ce27b6575d69755c73e65d4468dba93a25644eed56dc12879cae9213
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git jq perl procps python3 unzip zip \
    && rm -rf /var/lib/apt/lists/*
# Match the repository's current TS execution fixture; no host node_modules mount.
RUN npm install -g --ignore-scripts --no-audit --no-fund ts-node@10.9.2 typescript@5.2.2 \
    && npm cache clean --force
WORKDIR /workspace
CMD ["sh", "-c", "node --test cli/test/*.test.cjs && node cli/scripts/verify-package.cjs"]
