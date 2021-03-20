#!/bin/bash
#author:spark thanks to: https://github.com/sparkssssssss/scripts

. /jd/config/config.sh
title=$(echo $1|sed 's/-/_/g')
msg=$(echo -e $2)

node /jd/shell/notify.js "$title" "$msg"