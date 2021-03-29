FROM node:lts-alpine as build
LABEL maintainer="whyour"
ARG QL_BASE_URL=https://github.com.cnpmjs.org/whyour/qinglong
ARG QL_BASE_BRANCH=master
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=zh_CN.UTF-8 \
    SHELL=/bin/bash \
    PS1="\u@\h:\w \$ " \
    QL_DIR=/ql
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
    && apk update -f \
    && apk upgrade \
    && apk --no-cache add -f coreutils \
                             moreutils \
                             git \
                             python \
                             make \
                             g++ \
                             yarn \
    && git clone -b ${QL_BASE_BRANCH} ${QL_BASE_URL} ${QL_DIR} \
    && cd ${QL_DIR} \
    && cp -f .env.example .env \
    && yarn --network-timeout 100000
FROM node:lts-alpine
LABEL maintainer="whyour"
ARG QL_BASE_URL=https://github.com.cnpmjs.org/whyour/qinglong
ARG QL_BASE_BRANCH=master
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=zh_CN.UTF-8 \
    SHELL=/bin/bash \
    PS1="\u@\h:\w \$ " \
    QL_DIR=/ql
WORKDIR ${QL_DIR}
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
    && apk update -f \
    && apk upgrade \
    && apk --no-cache add -f bash \
                             coreutils \
                             moreutils \
                             git \
                             wget \
                             curl \
                             nano \
                             tzdata \
                             perl \
                             openssl \
                             nginx \
                             python \
                             make \
                             g++ \
                             yarn \
    && rm -rf /var/cache/apk/* \
    && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && touch ~/.bashrc \
    && mkdir /run/nginx \
    && git clone -b ${QL_BASE_BRANCH} ${QL_BASE_URL} ${QL_DIR} \
    && cd ${QL_DIR} \
    && cp -f .env.example .env \
    && ln -sf ${QL_DIR}/shell/js.sh /usr/local/bin/js \
    && ln -sf ${QL_DIR}/shell/git_pull.sh /usr/local/bin/git_pull \
    && ln -sf ${QL_DIR}/shell/rm_log.sh /usr/local/bin/rm_log \
    && ln -sf ${QL_DIR}/shell/export_sharecodes.sh /usr/local/bin/export_sharecodes \
    && ln -sf ${QL_DIR}/shell/git_diy.sh /usr/local/bin/diy \
    && ln -sf ${QL_DIR}/shell/notify.sh /usr/local/bin/notify \
    && ln -sf ${QL_DIR}/shell/rebuild.sh /usr/local/bin/rebuild \
    && ln -sf ${QL_DIR}/docker/docker-entrypoint.sh /usr/local/bin/entrypoint \
    && chmod 777 ${QL_DIR}/shell/*.sh \
    && chmod 777 ${QL_DIR}/docker/*.sh \
    && npm install -g pm2 \
    && rm -rf /root/.npm
COPY --from=build /ql/node_modules /ql/node_modules/
RUN cd ${QL_DIR} \
    && yarn build \
    && yarn build-back
ENTRYPOINT ["entrypoint"]