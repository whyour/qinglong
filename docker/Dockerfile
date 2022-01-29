FROM whyour/ql:base
ARG QL_MAINTAINER="whyour"
LABEL maintainer="${QL_MAINTAINER}"
ARG QL_URL=https://github.com/${QL_MAINTAINER}/qinglong.git
ARG QL_BRANCH=master

ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=zh_CN.UTF-8 \
    SHELL=/bin/bash \
    PS1="\u@\h:\w \$ " \
    QL_DIR=/ql \
    QL_BRANCH=${QL_BRANCH}

WORKDIR ${QL_DIR}

RUN git clone -b ${QL_BRANCH} ${QL_URL} ${QL_DIR} \
    && cd ${QL_DIR} \
    && cp -f .env.example .env \
    && chmod 777 ${QL_DIR}/shell/*.sh \
    && chmod 777 ${QL_DIR}/docker/*.sh \
    && pnpm uninstall sqlite3 2>&1 > /dev/null || echo "卸载sqlite3失败" \
    && rm -rf node_modules \
    && pnpm install --prod \
    && cp -rf /usr/local/pnpm-global/5/node_modules/sqlite3 ./node_modules/ \
    && cp -rf /usr/local/pnpm-global/5/node_modules/.pnpm/sqlite* ./node_modules/.pnpm/ \
    && git checkout . \
    && pnpm install --prod \
    && rm -rf /root/.pnpm-store \
    && git clone -b ${QL_BRANCH} https://github.com/${QL_MAINTAINER}/qinglong-static.git /static \
    && cp -rf /static/* ${QL_DIR} \
    && rm -rf /static
ENTRYPOINT ["./docker/docker-entrypoint.sh"]
