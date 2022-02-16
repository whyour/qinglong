FROM node:alpine
ARG QL_MAINTAINER="whyour"
LABEL maintainer="${QL_MAINTAINER}"

ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=zh_CN.UTF-8 \
    SHELL=/bin/bash \
    PS1="\u@\h:\w \$ "

COPY package.json /

RUN set -x \
    && sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
    && apk update -f \
    && apk upgrade \
    && apk --no-cache add -f bash \
                             coreutils \
                             moreutils \
                             git \
                             curl \
                             wget \
                             tzdata \
                             perl \
                             openssl \
                             nginx \
                             python3 \
                             jq \
                             openssh \
                             py3-pip \
                             python2 \
                             g++ \
                             make \
    && rm -rf /var/cache/apk/* \
    && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && touch ~/.bashrc \
    && git config --global user.email "qinglong@@users.noreply.github.com" \
    && git config --global user.name "qinglong" \
    && npm install -g pnpm \
    && pnpm install -g pm2 \
    && pnpm install -g ts-node typescript tslib \
    && cd / && pnpm install --prod \
    && apk --purge del python2 g++ make \
    && rm -rf /root/.npm \
    && rm -rf /root/.pnpm-store \
    && rm -rf /root/.cache \
    && rm -f /package.json

CMD [ "node" ]
