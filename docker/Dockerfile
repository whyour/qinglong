FROM node:20-slim AS nodebuilder

FROM python:3.11-slim AS builder
COPY package.json .npmrc pnpm-lock.yaml /tmp/build/
COPY --from=nodebuilder /usr/local/bin/node /usr/local/bin/
COPY --from=nodebuilder /usr/local/lib/node_modules/. /usr/local/lib/node_modules/
RUN set -x && \
  ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
  apt update && \
  apt install --no-install-recommends -y libatomic1 && \
  npm i -g pnpm@8.3.1 && \
  cd /tmp/build && \
  pnpm install --prod

FROM python:3.11-slim

ARG QL_MAINTAINER="whyour"
LABEL maintainer="${QL_MAINTAINER}"
ARG QL_URL=https://github.com/${QL_MAINTAINER}/qinglong.git
ARG QL_BRANCH=develop
ARG PYTHON_SHORT_VERSION=3.11

ENV QL_DIR=/ql \
  QL_BRANCH=${QL_BRANCH} \
  LANG=C.UTF-8 \
  SHELL=/bin/bash \
  PS1="\u@\h:\w \$ "

COPY --from=nodebuilder /usr/local/bin/node /usr/local/bin/
COPY --from=nodebuilder /usr/local/lib/node_modules/. /usr/local/lib/node_modules/

RUN set -x && \
  ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
  apt update && \
  apt upgrade -y && \
  apt install --no-install-recommends -y git \
  curl \
  wget \
  jq \
  procps \
  netcat \
  unzip \
  libatomic1 && \
  apt clean && \
  ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
  echo "Asia/Shanghai" >/etc/timezone && \
  git config --global user.email "qinglong@users.noreply.github.com" && \
  git config --global user.name "qinglong" && \
  git config --global http.postBuffer 524288000 && \
  npm install -g pnpm@8.3.1 pm2 ts-node && \
  rm -rf /root/.cache && \
  rm -rf /root/.npm && \
  ulimit -c 0

ARG SOURCE_COMMIT
RUN git clone --depth=1 -b ${QL_BRANCH} ${QL_URL} ${QL_DIR} && \
  cd ${QL_DIR} && \
  cp -f .env.example .env && \
  chmod 777 ${QL_DIR}/shell/*.sh && \
  chmod 777 ${QL_DIR}/docker/*.sh && \
  git clone --depth=1 -b ${QL_BRANCH} https://github.com/${QL_MAINTAINER}/qinglong-static.git /static && \
  mkdir -p ${QL_DIR}/static && \
  cp -rf /static/* ${QL_DIR}/static && \
  rm -rf /static

ENV PNPM_HOME=${QL_DIR}/data/dep_cache/node \
  PYTHON_HOME=${QL_DIR}/data/dep_cache/python3 \
  PYTHONUSERBASE=${QL_DIR}/data/dep_cache/python3

ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PNPM_HOME}:${PYTHON_HOME}/bin \
  NODE_PATH=/usr/local/bin:/usr/local/lib/node_modules:${PNPM_HOME}/global/5/node_modules \
  PIP_CACHE_DIR=${PYTHON_HOME}/pip \
  PYTHONPATH=${PYTHON_HOME}:${PYTHON_HOME}/lib/python${PYTHON_SHORT_VERSION}:${PYTHON_HOME}/lib/python${PYTHON_SHORT_VERSION}/site-packages

RUN pip3 install --prefix ${PYTHON_HOME} requests

COPY --from=builder /tmp/build/node_modules/. /ql/node_modules/

WORKDIR ${QL_DIR}

HEALTHCHECK --interval=5s --timeout=2s --retries=20 \
  CMD curl -sf --noproxy '*' http://127.0.0.1:5700/api/health || exit 1

ENTRYPOINT ["./docker/docker-entrypoint.sh"]

VOLUME /ql/data
  
EXPOSE 5700
