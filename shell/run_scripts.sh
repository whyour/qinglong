#!/bin/bash
# Version: v4.7.14
# sed分隔符可修改
# 青龙面板task补充

## 导入通用变量与函数
dir_shell=/ql/shell
. $dir_shell/share.sh

SCRIPT="$1"

# VIP人数，默认前面的
VIPS=${JD_SH_VIP:-0}
SCRIPT_NAME=`echo "${SCRIPT}" | awk -F "." '{print $1}'`

home="/ql"
# 助力码文件目录
SHCD_DIR="${home}/sharecode"

# 脚本文件初始目录
SCRIPT_DIR="${home}/scripts"

# 推送脚本
NOTIFY_SCRIPT="${SCRIPT_DIR}/${SCRIPT_NAME}_run_sendNotify.js"
NOTIFY_SCRIPT_SPEC="${SCRIPT_DIR}/${SCRIPT_NAME}_run_sendNotify_spec.js"

LOG="${SHCD_DIR}/${SCRIPT_NAME}.log"
MSG_DIR="${home}/JDmsg"
NOTIFY_CONF="${MSG_DIR}/${SCRIPT_NAME}_dt.conf"

# 推送JS
NOTIFY_JS="${SCRIPT_DIR}/${SCRIPT_NAME}_sendNotify.js"
NOTIFY_JS_RETURN="${SCRIPT_DIR}/${SCRIPT_NAME}_return_sendNotify.js"

[ ! -d ${SHCD_DIR} ] && mkdir ${SHCD_DIR}
[ ! -d ${MSG_DIR} ] && mkdir ${MSG_DIR}

# 格式化助力码
autoHelp(){
# $1 脚本文件，绝对路径
# $2 助力码文件所在，绝对路径
    sr_file=$1
    sc_file=$2
    sc_list=(`cat "$sc_file" | while read LINE; do echo $LINE; done | awk -F "】" '{print $2}'`)
    sc_vip_list=(`echo ${sc_list[*]:0:VIPS}`)
    nums_of_user=`echo ${#sc_list[*]}`
    sc_normal_list=(`echo ${sc_list[*]:VIPS:nums_of_user}`)
    f_shcode=""
    IFS=$'\n'
	if [ -n `echo "$JD_COOKIE" | grep "&"` ]; then
		JK_LIST=(`echo "$JD_COOKIE" | awk -F "&" '{for(i=1;i<=NF;i++) print $i}'`)
	else
		JK_LIST=(`echo "$JD_COOKIE" | awk -F "$" '{for(i=1;i<=NF;i++){{if(length($i)!=0) print $i}}'`)
	fi
    if [ -n "$JK_LIST" ]; then
        diff=$((${#JK_LIST[*]}-$nums_of_user))
        for e in `seq 1 $diff`
        do 
            sc_list+=(${sc_list[0]})
            unset sc_list[0]
            sc_list=(${sc_list[*]})
            f_shcode="$f_shcode""'""`echo ${sc_list[*]:0} | awk '{for(i=1;i<=NF;i++) {if(i==NF) printf $i;else printf $i"@"}}'`""',""\n"
        done
    fi
    # 优先为vip用户助力
    for e in `seq 1 $nums_of_user`
    do 
    	if [ $((VIPS-0)) -ge $e ]; then
		sc_vip_list+=(${sc_vip_list[0]})
		unset sc_vip_list[0]
		sc_vip_list=(${sc_vip_list[*]})
	else
		sc_normal_list+=(${sc_normal_list[0]})
		unset sc_normal_list[0]
		sc_normal_list=(${sc_normal_list[*]})
	fi
	final_sc_list=(`echo ${sc_vip_list[*]} ${sc_normal_list[*]}`)
        f_shcode="$f_shcode""'""`echo ${final_sc_list[*]:0} | awk '{for(i=1;i<=NF;i++) {if(i==NF) printf $i;else printf $i"@"}}'`""',""\n"
    done
 
    unset IFS
    [ -n "$MY_SHARECODES" ] && f_shcode="$f_shcode""'$MY_SHARECODES',\n"
    sed -i "s/let shareCodes = \[/let shareCodes = \[\n${f_shcode}/g" "$sr_file"
    sed -i "s/const inviteCodes = \[/const inviteCodes = \[\n${f_shcode}/g" "$sr_file"
    sed -i "s/let inviteCodes = \[/let inviteCodes = \[\n${f_shcode}/g" "$sr_file"
    # 修改种豆得豆
    if [ "$1" = "jd_plantBean.js" ]; then
        sed -i "s/let PlantBeanShareCodes = \[/let PlantBeanShareCodes = \[\n${f_shcode}/g" "${SCRIPT_DIR}/jdPlantBeanShareCodes.js"
    fi
    # 修改东东萌宠
    if [ "$1" = "jd_pet.js" ]; then
        sed -i "s/let PetShareCodes = \[/let PetShareCodes = \[\n${f_shcode}/g" "${SCRIPT_DIR}/jdPetShareCodes.js"
    fi
    # 修改东东农场
    if [ "$1" = "jd_fruit.js" ]; then
        sed -i "s/let FruitShareCodes = \[/let FruitShareCodes = \[\n${f_shcode}/g" "${SCRIPT_DIR}/jdFruitShareCodes.js"
    fi
    # 修改京喜工厂
    if [ "$1" = "jd_dreamFactory.js" ]; then
        sed -i "s/let shareCodes = \[/let shareCodes = \[\n${f_shcode}/g" "${SCRIPT_DIR}/jdDreamFactoryShareCodes.js"
    fi
    # 修改东东工厂
    if [ "$1" = "jd_jdfactory.js" ]; then
        sed -i "s/let shareCodes = \[/let shareCodes = \[\n${f_shcode}/g" "${SCRIPT_DIR}/jdFactoryShareCodes.js"
    fi
}

# 收集助力码
collectSharecode(){
    echo "${1}：收集新助力码"
    code=`sed -n '/'码】'.*/'p ${1}`
    if [ -z "$code" ]; then
        activity=`sed -n '/配置文件.*/'p "${1}" | awk -F "获取" '{print $2}' | awk -F "配置" '{print $1}'`
        name=(`sed -n '/'【京东账号'.*/'p "${1}" | grep "开始" | awk -F "开始" '{print $2}' |sed 's/】/（/g'| awk -v ac="$activity" -F "*" '{print $1"）" ac "好友助力码】"}'`)
        # 相邻重复去重
	code=(`sed -n '/'您的好友助力码为'.*/'p ${1} | awk '{print $2}' | uniq`)
        [ -z "$code" ] && code=(`sed -n '/'好友助力码'.*/'p ${1} | awk -F "：" '{print $2}' | uniq`)
        [ -z "$code" ] && return
        for i in `seq 0 $((${#name[*]}-1))`
        do 
            [ -n "${code[i]}" ] && echo "${name[i]}""${code[i]}" >> ${LOG}
        done
    else
        echo $code | awk '{for(i=1;i<=NF;i++)print $i}' > ${LOG}
    fi
}

# 清除连续空行为一行和首尾空行
blank_lines2blank_line(){
	# $1: 文件名
    # 删除连续空行为一行
    cat -s $1 > $1.bk
    mv -f $1.bk $1
    #清除文首文末空行
    [ "$(cat $1 | head -n 1)"x = ""x ] && sed -i '1d' $1
    [ "$(cat $1 | tail -n 1)"x = ""x ] && sed -i '$d' $1
}

# 判断是否需要特别推送
specify_send(){
  ret=`cat $1 2>&1 | grep "提醒\|已超时\|已可兑换\|已失效\|重新登录\|已可领取\|未选择商品\|兑换地址\|未继续领养"`
  [ -n "$ret" ] && echo 1 || echo 0
}

# 传入需要的环境变量
deliver_env(){
	env_var=(`cat $1 | grep process.env | awk -F "." '{print $3}' | awk '{print $1}' | awk -F ";|)" '{print $1}' | grep "_" | sort -u | uniq`)
	for var in ${env_var[*]}
	do
		val=`eval echo '$'{$var}`
		[ -n $val ] && sed -i "s/let $var = ''/let ${var} = '${val}'/g" $1
	done
}

# 主函数
main(){
	cd ${SCRIPT_DIR}

	log_time=$(date "+%Y-%m-%d-%H-%M-%S")
	log_dir_tmp="${SCRIPT_NAME##*/}"
	log_dir="$dir_log/${log_dir_tmp%%.*}"
	log_path="$log_dir/$log_time.log.tmp"
	make_dir "$log_dir"
	
	if [[ $SCRIPT == *.py ]]; then
		python3 $SCRIPT 2>&1 | tee ${log_path}
		if [ "$SCRIPT" == "jd_OpenCard.py" ]; then
			strat_end_line_list=(`cat $log_path | grep -n "本次统计\|入会总耗时" | awk -F ':' '{print $1}'`)
			TITLE="入会领京豆"
			CONTENT=`sed -n "${a},${a[-1]}p" ${log_path}`
			python3 -c "import SendMsg;send = SendMsg.SendMsg(\"${DD_BOT_TOKEN}\", \"${DD_BOT_SECRET}\");send.msg(\"${TITLE}\", \"${CONTENT}\")"
		fi
		rm -f ${log_path}
		return
	fi

	# 备份
	cp -f ${SCRIPT_DIR}/${SCRIPT} ${SCRIPT_DIR}/${SCRIPT_NAME}_tmp.js
	
	echo "修改发送方式"

#修改常规推送
	cat > ${NOTIFY_SCRIPT} <<EOF
notify = require('${NOTIFY_JS}');
fs = require('fs');
var data = fs.readFileSync('${NOTIFY_CONF}');
var name = fs.readFileSync('${NOTIFY_CONF}name');

notify.sendNotify(name, data.toString());
EOF
#修改特别推送
	cat > ${NOTIFY_SCRIPT_SPEC} <<EOT
notify = require('${NOTIFY_JS}');
fs = require('fs');
var data = fs.readFileSync('${NOTIFY_CONF}spec');
var name = fs.readFileSync('${NOTIFY_CONF}name');

notify.sendNotify(name, data.toString());
EOT
	# 推送js复制
	cp -f ${SCRIPT_DIR}/sendNotify.js ${NOTIFY_JS}
	cp -f ${SCRIPT_DIR}/sendNotify.js ${NOTIFY_JS_RETURN}
	sed -i 's/text = text.match/\/\/text = text.match/g' ${NOTIFY_JS_RETURN}

	# 删除旧消息
	rm -f ${NOTIFY_CONF}*
	
	sed -i "s/desp += author/\/\/desp += author/g" ${NOTIFY_JS}
	sed -i "/text = text.match/a   var fs = require('fs');fs.writeFile(\"${NOTIFY_CONF}name\", text + \"\\\n\", function(err) {if(err) {return console.log(err);}});fs.appendFile(\"${NOTIFY_CONF}\" + new Date().getTime(), desp + \"\\\n\", function(err) {if(err) {return console.log(err);}});\n  return" ${NOTIFY_JS_RETURN}
	sed -i "s#.\/sendNotify#${NOTIFY_JS_RETURN}#g" ${SCRIPT_DIR}/${SCRIPT_NAME}_tmp.js
	[ ! -e "./$SCRIPT" ] && echo "脚本不存在" && exit 0

	echo "替换助力码"
	[ -e "${SHCD_DIR}/${SCRIPT_NAME}.log" ] && autoHelp "${SCRIPT_DIR}/${SCRIPT_NAME}_tmp.js" "${SHCD_DIR}/${SCRIPT_NAME}.log"
    
	echo "开始运行"
	(node ${SCRIPT_DIR}/${SCRIPT_NAME}_tmp.js | grep -Ev "pt_pin|pt_key") >&1 | tee ${log_path}

	# 整合推送消息
	IFS=$'\n'
	for n in `ls ${MSG_DIR} | grep ${SCRIPT_NAME}_dt.conf | grep -v ${SCRIPT_NAME}_dt.confname`
	do
		echo "正在处理${MSG_DIR}/${n}文本"
		if [ $(specify_send ${MSG_DIR}/${n}) -eq 0 ];then
			cat ${MSG_DIR}/${n} >> ${NOTIFY_CONF}
		else
			cat ${MSG_DIR}/${n} >> ${NOTIFY_CONF}spec
		fi
		# 清空文件
		rm -f ${MSG_DIR}/${n}
	done
	unset IFS
	
	echo "推送消息"
	sed -i 's/text}\\n\\n/text}\\n/g' ${NOTIFY_JS}
	sed -i 's/\\n\\n本脚本/\\n本脚本/g' ${NOTIFY_JS}
	sed -i 's/text = text.match/\/\/text = text.match/g' ${NOTIFY_JS}
	
	# 传递变量
	deliver_env ${NOTIFY_JS}

	if [ -e ${NOTIFY_CONF} -a -n "$(cat ${NOTIFY_CONF} 2>&1 | sed '/^$/d')" ]; then
		blank_lines2blank_line  ${NOTIFY_CONF}
		blank_lines2blank_line  ${NOTIFY_CONF}name
		cat ${NOTIFY_CONF}
		node ${NOTIFY_SCRIPT}
	fi
	# 特殊推送
	if [ -e ${NOTIFY_CONF}spec -a -n "$(cat ${NOTIFY_CONF}spec 2>&1 | sed '/^$/d')" ]; then
		blank_lines2blank_line  ${NOTIFY_CONF}spec
		blank_lines2blank_line  ${NOTIFY_CONF}name
		cat ${NOTIFY_CONF}spec
		if [ -n "$DD_BOT_TOKEN_SPEC" -a -n "$DD_BOT_SECRET_SPEC" ]; then
			sed -i "s/DD_BOT_TOKEN/DD_BOT_TOKEN_SPEC/g" ${NOTIFY_JS}
			sed -i "s/DD_BOT_SECRET/DD_BOT_SECRET_SPEC/g" ${NOTIFY_JS}
			sed -i "s/let DD_BOT_TOKEN_SPEC/let DD_BOT_TOKEN_SPEC_OLD/g" ${NOTIFY_JS}
			sed -i "s/let DD_BOT_SECRET_SPEC/let DD_BOT_SECRET_SPEC_OLD/g" ${NOTIFY_JS}
			sed -i "/let DD_BOT_TOKEN_SPEC_OLD/a let DD_BOT_TOKEN_SPEC = '${DD_BOT_TOKEN_SPEC}'" ${NOTIFY_JS}
			sed -i "/let DD_BOT_SECRET_SPEC_OLD/a let DD_BOT_SECRET_SPEC = '${DD_BOT_SECRET_SPEC}'" ${NOTIFY_JS}
		fi
		node ${NOTIFY_SCRIPT_SPEC}
	fi
	
	echo "删除旧文件"
	rm -f ${SCRIPT_DIR}/${SCRIPT_NAME}_tmp.js
	rm -f ${NOTIFY_JS}
	rm -f ${NOTIFY_JS_RETURN}
	rm -f ${NOTIFY_SCRIPT}
	rm -f ${NOTIFY_SCRIPT_SPEC}
	
	# 助力码收集
	collectSharecode ${log_path}
	rm -f ${log_path}
}
main
