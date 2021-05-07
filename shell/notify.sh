#!/bin/bash
#author:spark thanks to: https://github.com/sparkssssssss/scripts

. /ql/config/config.sh
title=$(echo $1|sed 's/-/_/g')
msg=$(echo -e $2)

node /ql/shell/notify.js "$title" "$msg"