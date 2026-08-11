FROM node:24-bookworm-slim

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd \
  && groupadd --gid 10001 ql3service \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin ql3service \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && systemctl mask systemd-remount-fs.service getty@.service console-getty.service

STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/lib/systemd/systemd"]
CMD []
