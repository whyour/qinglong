FROM node:24-alpine

RUN apk add --no-cache openrc \
  && addgroup -g 10001 -S ql3service \
  && adduser -u 10001 -S -D -H -G ql3service -s /sbin/nologin ql3service \
  && mkdir -p /run/openrc

ENTRYPOINT ["node", "-e", "const fs=require('node:fs');fs.mkdirSync('/run/openrc',{recursive:true});fs.writeFileSync('/run/openrc/softlevel','default\\n');setInterval(()=>{},2147483647)"]
