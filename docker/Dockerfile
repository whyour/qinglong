FROM node:lts-alpine
LABEL maintainer="whyour"
ARG JD_BASE_URL=https://github.com.cnpmjs.org/whyour/qinglong
ARG JD_BASE_BRANCH=master
ARG JD_SCRIPTS_URL=https://github.com.cnpmjs.org/RikudouPatrickstar/jd_scripts
ARG JD_SCRIPTS_BRANCH=master
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=zh_CN.UTF-8 \
    SHELL=/bin/bash \
    PS1="\u@\h:\w \$ " \
    JD_DIR=/jd
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
    && git clone -b ${JD_BASE_BRANCH} ${JD_BASE_URL} ${JD_DIR} \
    && cd ${JD_DIR} \
    && cp -f .env.example .env \
    && ln -sf ${JD_DIR}/shell/jd.sh /usr/local/bin/jd \
    && ln -sf ${JD_DIR}/shell/git_pull.sh /usr/local/bin/git_pull \
    && ln -sf ${JD_DIR}/shell/rm_log.sh /usr/local/bin/rm_log \
    && ln -sf ${JD_DIR}/shell/export_sharecodes.sh /usr/local/bin/export_sharecodes \
    && ln -sf ${JD_DIR}/shell/git_diy.sh /usr/local/bin/diy \
    && ln -sf ${JD_DIR}/shell/notify.sh /usr/local/bin/notify \
    && yarn install \
    && yarn build \
    && yarn build-back \
    && yarn install --production \
    && git clone -b ${JD_SCRIPTS_BRANCH} ${JD_SCRIPTS_URL} ${JD_DIR}/scripts \
    && cd ${JD_DIR}/scripts \
    && npm install --production\
    && npm install -g pm2 \
    && rm -rf /root/.npm
WORKDIR ${JD_DIR}
ENTRYPOINT bash ${JD_DIR}/docker/docker-entrypoint.sh