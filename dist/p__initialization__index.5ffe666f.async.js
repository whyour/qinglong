(self.webpackChunk=self.webpackChunk||[]).push([[4585],{45589:function(se,_,e){"use strict";e.d(_,{Z:function(){return P}});var v=e(81602),r=e(12924),F={icon:{tag:"svg",attrs:{viewBox:"64 64 896 896",focusable:"false"},children:[{tag:"path",attrs:{d:"M942.2 486.2C847.4 286.5 704.1 186 512 186c-192.2 0-335.4 100.5-430.2 300.3a60.3 60.3 0 000 51.5C176.6 737.5 319.9 838 512 838c192.2 0 335.4-100.5 430.2-300.3 7.7-16.2 7.7-35 0-51.5zM512 766c-161.3 0-279.4-81.8-362.7-254C232.6 339.8 350.7 258 512 258c161.3 0 279.4 81.8 362.7 254C791.5 684.2 673.4 766 512 766zm-4-430c-97.2 0-176 78.8-176 176s78.8 176 176 176 176-78.8 176-176-78.8-176-176-176zm0 288c-61.9 0-112-50.1-112-112s50.1-112 112-112 112 50.1 112 112-50.1 112-112 112z"}}]},name:"eye",theme:"outlined"},T=F,i=e(1719),z=function(Y,L){return r.createElement(i.Z,(0,v.Z)((0,v.Z)({},Y),{},{ref:L,icon:T}))};z.displayName="EyeOutlined";var P=r.forwardRef(z)},24469:function(se){se.exports={container:"container___kt4TS",top:"top___but-E",header:"header___g8Zm7",logo:"logo___2nVz6",title:"title___31Kfx",desc:"desc___3UpVk",main:"main___3Ley5","ant-steps":"ant-steps___22Lrk","steps-container":"steps-container___1iiDs",extra:"extra___WMKko"}},14194:function(){},8152:function(se,_,e){"use strict";e.d(_,{m:function(){return v.m}});var v=e(76162),r=e(90249)},41132:function(se,_,e){"use strict";e.r(_),e.d(_,{default:function(){return ge}});var v=e(94068),r=e(42061),F=e(54598),T=e(189),i=e(72912),z=e(73742),P=e(84263),H=e(42273),Y=e(53086),L=e(85141),J=e(69944),ie=e(42857),ne=e(74344),le=e(14194),B=e(53317),ee=e(74286),M=e(86545),Pe=e(6410),ce=e(46434),he=e(19803),q=e.n(he),I=e(81602),Ee=e(13133),b=e(48493),ae=e(16071),ye=e(99335),Oe=e(47893),m=e(12924),s=e.n(m),be=e(79014),Ne=["className","prefixCls","style","active","status","iconPrefix","icon","wrapperStyle","stepNumber","disabled","description","title","subTitle","progressDot","stepIcon","tailContent","icons","stepIndex","onStepClick","onClick"];function Se(Z){return typeof Z=="string"}var me=function(Z){(0,ye.Z)(f,Z);var g=(0,Oe.Z)(f);function f(){var d;return(0,b.Z)(this,f),d=g.apply(this,arguments),d.onClick=function(){var l=d.props,t=l.onClick,n=l.onStepClick,u=l.stepIndex;t&&t.apply(void 0,arguments),n(u)},d}return(0,ae.Z)(f,[{key:"renderIconNode",value:function(){var l,t=this.props,n=t.prefixCls,u=t.progressDot,K=t.stepIcon,w=t.stepNumber,A=t.status,Q=t.title,R=t.description,O=t.icon,X=t.iconPrefix,h=t.icons,x,$=q()("".concat(n,"-icon"),"".concat(X,"icon"),(l={},(0,M.Z)(l,"".concat(X,"icon-").concat(O),O&&Se(O)),(0,M.Z)(l,"".concat(X,"icon-check"),!O&&A==="finish"&&(h&&!h.finish||!h)),(0,M.Z)(l,"".concat(X,"icon-cross"),!O&&A==="error"&&(h&&!h.error||!h)),l)),o=m.createElement("span",{className:"".concat(n,"-icon-dot")});return u?typeof u=="function"?x=m.createElement("span",{className:"".concat(n,"-icon")},u(o,{index:w-1,status:A,title:Q,description:R})):x=m.createElement("span",{className:"".concat(n,"-icon")},o):O&&!Se(O)?x=m.createElement("span",{className:"".concat(n,"-icon")},O):h&&h.finish&&A==="finish"?x=m.createElement("span",{className:"".concat(n,"-icon")},h.finish):h&&h.error&&A==="error"?x=m.createElement("span",{className:"".concat(n,"-icon")},h.error):O||A==="finish"||A==="error"?x=m.createElement("span",{className:$}):x=m.createElement("span",{className:"".concat(n,"-icon")},w),K&&(x=K({index:w-1,status:A,title:Q,description:R,node:x})),x}},{key:"render",value:function(){var l,t=this.props,n=t.className,u=t.prefixCls,K=t.style,w=t.active,A=t.status,Q=A===void 0?"wait":A,R=t.iconPrefix,O=t.icon,X=t.wrapperStyle,h=t.stepNumber,x=t.disabled,$=t.description,o=t.title,c=t.subTitle,j=t.progressDot,V=t.stepIcon,Me=t.tailContent,Te=t.icons,Ze=t.stepIndex,De=t.onStepClick,Ae=t.onClick,Be=(0,Ee.Z)(t,Ne),_e=q()("".concat(u,"-item"),"".concat(u,"-item-").concat(Q),n,(l={},(0,M.Z)(l,"".concat(u,"-item-custom"),O),(0,M.Z)(l,"".concat(u,"-item-active"),w),(0,M.Z)(l,"".concat(u,"-item-disabled"),x===!0),l)),Re=(0,I.Z)({},K),fe={};return De&&!x&&(fe.role="button",fe.tabIndex=0,fe.onClick=this.onClick),m.createElement("div",Object.assign({},Be,{className:_e,style:Re}),m.createElement("div",Object.assign({onClick:Ae},fe,{className:"".concat(u,"-item-container")}),m.createElement("div",{className:"".concat(u,"-item-tail")},Me),m.createElement("div",{className:"".concat(u,"-item-icon")},this.renderIconNode()),m.createElement("div",{className:"".concat(u,"-item-content")},m.createElement("div",{className:"".concat(u,"-item-title")},o,c&&m.createElement("div",{title:typeof c=="string"?c:void 0,className:"".concat(u,"-item-subtitle")},c)),$&&m.createElement("div",{className:"".concat(u,"-item-description")},$))))}}]),f}(m.Component),xe=["prefixCls","style","className","children","direction","type","labelPlacement","iconPrefix","status","size","current","progressDot","stepIcon","initial","icons","onChange"],a=function(Z){(0,ye.Z)(f,Z);var g=(0,Oe.Z)(f);function f(){var d;return(0,b.Z)(this,f),d=g.apply(this,arguments),d.onStepClick=function(l){var t=d.props,n=t.onChange,u=t.current;n&&u!==l&&n(l)},d}return(0,ae.Z)(f,[{key:"render",value:function(){var l,t=this,n=this.props,u=n.prefixCls,K=n.style,w=K===void 0?{}:K,A=n.className,Q=n.children,R=n.direction,O=n.type,X=n.labelPlacement,h=n.iconPrefix,x=n.status,$=n.size,o=n.current,c=n.progressDot,j=n.stepIcon,V=n.initial,Me=n.icons,Te=n.onChange,Ze=(0,Ee.Z)(n,xe),De=O==="navigation",Ae=c?"vertical":X,Be=q()(u,"".concat(u,"-").concat(R),A,(l={},(0,M.Z)(l,"".concat(u,"-").concat($),$),(0,M.Z)(l,"".concat(u,"-label-").concat(Ae),R==="horizontal"),(0,M.Z)(l,"".concat(u,"-dot"),!!c),(0,M.Z)(l,"".concat(u,"-navigation"),De),l));return s().createElement("div",Object.assign({className:Be,style:w},Ze),(0,be.Z)(Q).map(function(_e,Re){var fe=V+Re,Ie=(0,I.Z)({stepNumber:"".concat(fe+1),stepIndex:fe,key:fe,prefixCls:u,iconPrefix:h,wrapperStyle:w,progressDot:c,stepIcon:j,icons:Me,onStepClick:Te&&t.onStepClick},_e.props);return x==="error"&&Re===o-1&&(Ie.className="".concat(u,"-next-error")),_e.props.status||(fe===o?Ie.status=x:fe<o?Ie.status="finish":Ie.status="wait"),Ie.active=fe===o,(0,m.cloneElement)(_e,Ie)}))}}]),f}(s().Component);a.Step=me,a.defaultProps={type:"default",prefixCls:"rc-steps",iconPrefix:"rc",direction:"horizontal",labelPlacement:"horizontal",initial:0,current:0,status:"process",size:"",progressDot:!1};var E=a,C=e(41082),p=e(25069),S=e(72566),pe=function(Z,g){var f={};for(var d in Z)Object.prototype.hasOwnProperty.call(Z,d)&&g.indexOf(d)<0&&(f[d]=Z[d]);if(Z!=null&&typeof Object.getOwnPropertySymbols=="function")for(var l=0,d=Object.getOwnPropertySymbols(Z);l<d.length;l++)g.indexOf(d[l])<0&&Object.prototype.propertyIsEnumerable.call(Z,d[l])&&(f[d[l]]=Z[d[l]]);return f},G=function(g){var f,d=g.percent,l=g.size,t=g.className,n=g.direction,u=g.responsive,K=pe(g,["percent","size","className","direction","responsive"]),w=(0,p.Z)(u),A=w.xs,Q=m.useContext(C.E_),R=Q.getPrefixCls,O=Q.direction,X=m.useCallback(function(){return u&&A?"vertical":n},[A,n]),h=R("steps",g.prefixCls),x=R("",g.iconPrefix),$=q()((f={},(0,M.Z)(f,"".concat(h,"-rtl"),O==="rtl"),(0,M.Z)(f,"".concat(h,"-with-progress"),d!==void 0),f),t),o={finish:m.createElement(Pe.Z,{className:"".concat(h,"-finish-icon")}),error:m.createElement(ce.Z,{className:"".concat(h,"-error-icon")})},c=function(V){var Me=V.node,Te=V.status;if(Te==="process"&&d!==void 0){var Ze=l==="small"?32:40,De=m.createElement("div",{className:"".concat(h,"-progress-icon")},m.createElement(S.Z,{type:"circle",percent:d,width:Ze,strokeWidth:4,format:function(){return null}}),Me);return De}return Me};return m.createElement(E,(0,ee.Z)({icons:o},K,{size:l,direction:X(),stepIcon:c,prefixCls:h,iconPrefix:x,className:$}))};G.Step=E.Step,G.defaultProps={current:0,responsive:!0};var k=G,Ce=e(68476),N=e(69583),W=e(41488),D=e(8152),ue=e(24469),y=e.n(ue),ve=e(97349),U=N.Z.Item,re=k.Step,oe=ie.Z.Option,de=L.Z.Link,te=()=>{var Z=(0,m.useState)(!1),g=(0,H.Z)(Z,2),f=g[0],d=g[1],l=s().useState(0),t=(0,H.Z)(l,2),n=t[0],u=t[1],K=(0,m.useState)([]),w=(0,H.Z)(K,2),A=w[0],Q=w[1],R=()=>{u(n+1)},O=()=>{u(n-1)},X=o=>{d(!0),ve.W.put("".concat(W.Z.apiPrefix,"user/init"),{data:{username:o.username,password:o.password}}).then(c=>{c.code===200?R():P.ZP.error(c.message)}).finally(()=>d(!1))},h=o=>{d(!0),ve.W.put("".concat(W.Z.apiPrefix,"user/notification/init"),{data:(0,i.Z)({},o)}).then(c=>{c&&c.code===200?R():P.ZP.error(c.message)}).finally(()=>d(!1))},x=o=>{var c=W.Z.notificationModeMap[o];Q(c||[])};(0,m.useEffect)(()=>{localStorage.removeItem(W.Z.authKey)},[]);var $=[{title:"\u6B22\u8FCE\u4F7F\u7528",content:s().createElement("div",{className:y().top,style:{marginTop:100}},s().createElement("div",{className:y().header},s().createElement("span",{className:y().title},"\u6B22\u8FCE\u4F7F\u7528\u9752\u9F99\u63A7\u5236\u9762\u677F")),s().createElement("div",{className:y().action},s().createElement(T.Z,{type:"primary",onClick:()=>{R()}},"\u5F00\u59CB\u5B89\u88C5")))},{title:"\u901A\u77E5\u8BBE\u7F6E",content:s().createElement(N.Z,{onFinish:h,layout:"vertical"},s().createElement(N.Z.Item,{label:"\u901A\u77E5\u65B9\u5F0F",name:"type",rules:[{required:!0,message:"\u8BF7\u9009\u62E9\u901A\u77E5\u65B9\u5F0F"}],style:{maxWidth:350}},s().createElement(ie.Z,{onChange:x,placeholder:"\u8BF7\u9009\u62E9\u901A\u77E5\u65B9\u5F0F"},W.Z.notificationModes.filter(o=>o.value!=="closed").map(o=>s().createElement(oe,{value:o.value},o.label)))),A.map(o=>s().createElement(N.Z.Item,{label:o.label,name:o.label,extra:o.tip,rules:[{required:o.required}],style:{maxWidth:400}},s().createElement(r.Z.TextArea,{autoSize:!0,placeholder:"\u8BF7\u8F93\u5165".concat(o.label)}))),s().createElement(T.Z,{type:"primary",htmlType:"submit",loading:f},"\u4FDD\u5B58"),s().createElement(T.Z,{type:"link",htmlType:"button",onClick:()=>R()},"\u8DF3\u8FC7"))},{title:"\u8D26\u6237\u8BBE\u7F6E",content:s().createElement(N.Z,{onFinish:X,layout:"vertical"},s().createElement(N.Z.Item,{label:"\u7528\u6237\u540D",name:"username",rules:[{required:!0}],style:{maxWidth:350}},s().createElement(r.Z,{placeholder:"\u7528\u6237\u540D"})),s().createElement(N.Z.Item,{label:"\u5BC6\u7801",name:"password",rules:[{required:!0},{pattern:/^(?!admin$).*$/,message:"\u5BC6\u7801\u4E0D\u80FD\u4E3Aadmin"}],hasFeedback:!0,style:{maxWidth:350}},s().createElement(r.Z,{type:"password",placeholder:"\u5BC6\u7801"})),s().createElement(N.Z.Item,{name:"confirm",label:"\u786E\u8BA4\u5BC6\u7801",dependencies:["password"],hasFeedback:!0,style:{maxWidth:350},rules:[{required:!0},o=>{var c=o.getFieldValue;return{validator(j,V){return!V||c("password")===V?Promise.resolve():Promise.reject(new Error("\u60A8\u8F93\u5165\u7684\u4E24\u4E2A\u5BC6\u7801\u4E0D\u5339\u914D\uFF01"))}}}]},s().createElement(r.Z.Password,{placeholder:"\u786E\u8BA4\u5BC6\u7801"})),s().createElement(T.Z,{type:"primary",htmlType:"submit",loading:f},"\u63D0\u4EA4"))},{title:"\u5B8C\u6210\u5B89\u88C5",content:s().createElement("div",{className:y().top,style:{marginTop:80}},s().createElement("div",{className:y().header},s().createElement("span",{className:y().title},"\u606D\u559C\u5B89\u88C5\u5B8C\u6210\uFF01"),s().createElement(de,{href:"https://github.com/whyour/qinglong",target:"_blank"},"Github"),s().createElement(de,{href:"https://t.me/jiao_long",target:"_blank"},"Telegram\u9891\u9053")),s().createElement("div",{style:{marginTop:16}},s().createElement(T.Z,{type:"primary",onClick:()=>{D.m.push("/login")}},"\u53BB\u767B\u5F55")))}];return s().createElement("div",{className:y().container},s().createElement("div",{className:y().top},s().createElement("div",{className:y().header},s().createElement("img",{alt:"logo",className:y().logo,src:"http://qn.whyour.cn/logo.png"}),s().createElement("span",{className:y().title},"\u521D\u59CB\u5316\u914D\u7F6E"))),s().createElement("div",{className:y().main},s().createElement(k,{current:n,direction:"vertical",size:"small",className:y()["ant-steps"]},$.map(o=>s().createElement(re,{key:o.title,title:o.title}))),s().createElement("div",{className:y()["steps-container"]},$[n].content)))},ge=te},41488:function(se,_){"use strict";_.Z={siteName:"\u9752\u9F99\u63A7\u5236\u9762\u677F",apiPrefix:"/api/",authKey:"token",layouts:[{name:"primary",include:[/.*/],exclude:[/(\/(en|zh))*\/login/]}],i18n:{languages:[{key:"pt-br",title:"Portugu\xEAs",flag:"/portugal.svg"},{key:"en",title:"English",flag:"/america.svg"},{key:"zh",title:"\u4E2D\u6587",flag:"/china.svg"}],defaultLanguage:"en"},scopes:[{name:"\u5B9A\u65F6\u4EFB\u52A1",value:"crons"},{name:"\u73AF\u5883\u53D8\u91CF",value:"envs"},{name:"\u8BA2\u9605\u7BA1\u7406",value:"subscriptions"},{name:"\u914D\u7F6E\u6587\u4EF6",value:"configs"},{name:"\u811A\u672C\u7BA1\u7406",value:"scripts"},{name:"\u4EFB\u52A1\u65E5\u5FD7",value:"logs"},{name:"\u4F9D\u8D56\u7BA1\u7406",value:"dependencies"},{name:"\u7CFB\u7EDF\u4FE1\u606F",value:"system"}],scopesMap:{crons:"\u5B9A\u65F6\u4EFB\u52A1",envs:"\u73AF\u5883\u53D8\u91CF",subscriptions:"\u8BA2\u9605\u7BA1\u7406",configs:"\u914D\u7F6E\u6587\u4EF6",scripts:"\u811A\u672C\u7BA1\u7406",logs:"\u4EFB\u52A1\u65E5\u5FD7",dependencies:"\u4F9D\u8D56\u7BA1\u7406",system:"\u7CFB\u7EDF\u4FE1\u606F"},notificationModes:[{value:"gotify",label:"Gotify"},{value:"goCqHttpBot",label:"GoCqHttpBot"},{value:"serverChan",label:"Server\u9171"},{value:"pushDeer",label:"PushDeer"},{value:"bark",label:"Bark"},{value:"telegramBot",label:"Telegram\u673A\u5668\u4EBA"},{value:"dingtalkBot",label:"\u9489\u9489\u673A\u5668\u4EBA"},{value:"weWorkBot",label:"\u4F01\u4E1A\u5FAE\u4FE1\u673A\u5668\u4EBA"},{value:"weWorkApp",label:"\u4F01\u4E1A\u5FAE\u4FE1\u5E94\u7528"},{value:"iGot",label:"IGot"},{value:"pushPlus",label:"PushPlus"},{value:"email",label:"\u90AE\u7BB1"},{value:"closed",label:"\u5DF2\u5173\u95ED"}],notificationModeMap:{gotify:[{label:"gotifyUrl",tip:"gotify\u7684url\u5730\u5740,\u4F8B\u5982 https://push.example.de:8080",required:!0},{label:"gotifyToken",tip:"gotify\u7684\u6D88\u606F\u5E94\u7528token\u7801",required:!0},{label:"gotifyPriority",tip:"\u63A8\u9001\u6D88\u606F\u7684\u4F18\u5148\u7EA7"}],goCqHttpBot:[{label:"goCqHttpBotUrl",tip:"\u63A8\u9001\u5230\u4E2A\u4EBAQQ: http://127.0.0.1/send_private_msg\uFF0C\u7FA4\uFF1Ahttp://127.0.0.1/send_group_msg",required:!0},{label:"goCqHttpBotToken",tip:"\u8BBF\u95EE\u5BC6\u94A5",required:!0},{label:"goCqHttpBotQq",tip:"\u5982\u679CGOBOT_URL\u8BBE\u7F6E /send_private_msg \u5219\u9700\u8981\u586B\u5165 user_id=\u4E2A\u4EBAQQ \u76F8\u53CD\u5982\u679C\u662F /send_group_msg \u5219\u9700\u8981\u586B\u5165 group_id=QQ\u7FA4",required:!0}],serverChan:[{label:"serverChanKey",tip:"Server\u9171SENDKEY",required:!0}],pushDeer:[{label:"pushDeerKey",tip:"PushDeer\u7684Key\uFF0Chttps://github.com/easychen/pushdeer",required:!0}],bark:[{label:"barkPush",tip:"Bark\u7684\u4FE1\u606FIP/\u8BBE\u5907\u7801\uFF0C\u4F8B\u5982\uFF1Ahttps://api.day.app/XXXXXXXX",required:!0},{label:"barkIcon",tip:"BARK\u63A8\u9001\u56FE\u6807,\u81EA\u5B9A\u4E49\u63A8\u9001\u56FE\u6807 (\u9700iOS15\u6216\u4EE5\u4E0A\u624D\u80FD\u663E\u793A)"},{label:"barkSound",tip:"BARK\u63A8\u9001\u94C3\u58F0,\u94C3\u58F0\u5217\u8868\u53BBAPP\u67E5\u770B\u590D\u5236\u586B\u5199"},{label:"barkGroup",tip:"BARK\u63A8\u9001\u6D88\u606F\u7684\u5206\u7EC4, \u9ED8\u8BA4\u4E3Aqinglong"}],telegramBot:[{label:"telegramBotToken",tip:"telegram\u673A\u5668\u4EBA\u7684token\uFF0C\u4F8B\u5982\uFF1A1077xxx4424:AAFjv0FcqxxxxxxgEMGfi22B4yh15R5uw",required:!0},{label:"telegramBotUserId",tip:"telegram\u7528\u6237\u7684id\uFF0C\u4F8B\u5982\uFF1A129xxx206",required:!0},{label:"telegramBotProxyHost",tip:"\u4EE3\u7406IP"},{label:"telegramBotProxyPort",tip:"\u4EE3\u7406\u7AEF\u53E3"},{label:"telegramBotProxyAuth",tip:"telegram\u4EE3\u7406\u914D\u7F6E\u8BA4\u8BC1\u53C2\u6570, \u7528\u6237\u540D\u4E0E\u5BC6\u7801\u7528\u82F1\u6587\u5192\u53F7\u8FDE\u63A5 user:password"},{label:"telegramBotApiHost",tip:"telegram api\u81EA\u5EFA\u7684\u53CD\u5411\u4EE3\u7406\u5730\u5740\uFF0C\u9ED8\u8BA4tg\u5B98\u65B9api"}],dingtalkBot:[{label:"dingtalkBotToken",tip:"\u9489\u9489\u673A\u5668\u4EBAwebhook token\uFF0C\u4F8B\u5982\uFF1A5a544165465465645d0f31dca676e7bd07415asdasd",required:!0},{label:"dingtalkBotSecret",tip:"\u5BC6\u94A5\uFF0C\u673A\u5668\u4EBA\u5B89\u5168\u8BBE\u7F6E\u9875\u9762\uFF0C\u52A0\u7B7E\u4E00\u680F\u4E0B\u9762\u663E\u793A\u7684SEC\u5F00\u5934\u7684\u5B57\u7B26\u4E32"}],weWorkBot:[{label:"weWorkBotKey",tip:"\u4F01\u4E1A\u5FAE\u4FE1\u673A\u5668\u4EBA\u7684 webhook(\u8BE6\u89C1\u6587\u6863 https://work.weixin.qq.com/api/doc/90000/90136/91770)\uFF0C\u4F8B\u5982\uFF1A693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa",required:!0}],weWorkApp:[{label:"weWorkAppKey",tip:"corpid,corpsecret,touser(\u6CE8:\u591A\u4E2A\u6210\u5458ID\u4F7F\u7528|\u9694\u5F00),agentid,\u6D88\u606F\u7C7B\u578B(\u9009\u586B,\u4E0D\u586B\u9ED8\u8BA4\u6587\u672C\u6D88\u606F\u7C7B\u578B) \u6CE8\u610F\u7528,\u53F7\u9694\u5F00(\u82F1\u6587\u8F93\u5165\u6CD5\u7684\u9017\u53F7)\uFF0C\u4F8B\u5982\uFF1Awwcfrs,B-76WERQ,qinglong,1000001,2COat",required:!0}],iGot:[{label:"iGotPushKey",tip:"iGot\u7684\u4FE1\u606F\u63A8\u9001key\uFF0C\u4F8B\u5982\uFF1Ahttps://push.hellyw.com/XXXXXXXX",required:!0}],pushPlus:[{label:"pushPlusToken",tip:"\u5FAE\u4FE1\u626B\u7801\u767B\u5F55\u540E\u4E00\u5BF9\u4E00\u63A8\u9001\u6216\u4E00\u5BF9\u591A\u63A8\u9001\u4E0B\u9762\u7684token(\u60A8\u7684Token)\uFF0C\u4E0D\u63D0\u4F9BPUSH_PLUS_USER\u5219\u9ED8\u8BA4\u4E3A\u4E00\u5BF9\u4E00\u63A8\u9001",required:!0},{label:"pushPlusUser",tip:"\u4E00\u5BF9\u591A\u63A8\u9001\u7684\u201C\u7FA4\u7EC4\u7F16\u7801\u201D\uFF08\u4E00\u5BF9\u591A\u63A8\u9001\u4E0B\u9762->\u60A8\u7684\u7FA4\u7EC4(\u5982\u65E0\u5219\u65B0\u5EFA)->\u7FA4\u7EC4\u7F16\u7801\uFF0C\u5982\u679C\u60A8\u662F\u521B\u5EFA\u7FA4\u7EC4\u4EBA\u3002\u4E5F\u9700\u70B9\u51FB\u201C\u67E5\u770B\u4E8C\u7EF4\u7801\u201D\u626B\u63CF\u7ED1\u5B9A\uFF0C\u5426\u5219\u4E0D\u80FD\u63A5\u53D7\u7FA4\u7EC4\u6D88\u606F\u63A8\u9001\uFF09"}],email:[{label:"emailService",tip:"\u90AE\u7BB1\u670D\u52A1\u540D\u79F0\uFF0C\u6BD4\u5982126\u3001163\u3001Gmail\u3001QQ\u7B49\uFF0C\u652F\u6301\u5217\u8868https://nodemailer.com/smtp/well-known/",required:!0},{label:"emailUser",tip:"\u90AE\u7BB1\u5730\u5740",required:!0},{label:"emailPass",tip:"\u90AE\u7BB1SMTP\u6388\u6743\u7801",required:!0}]},documentTitleMap:{"/login":"\u767B\u5F55","/initialization":"\u521D\u59CB\u5316","/cron":"\u5B9A\u65F6\u4EFB\u52A1","/env":"\u73AF\u5883\u53D8\u91CF","/subscription":"\u8BA2\u9605\u7BA1\u7406","/config":"\u914D\u7F6E\u6587\u4EF6","/script":"\u811A\u672C\u7BA1\u7406","/diff":"\u5BF9\u6BD4\u5DE5\u5177","/log":"\u4EFB\u52A1\u65E5\u5FD7","/setting":"\u7CFB\u7EDF\u8BBE\u7F6E","/error":"\u9519\u8BEF\u65E5\u5FD7"},dependenceTypes:["nodejs","python3","linux"]}},97349:function(se,_,e){"use strict";e.d(_,{W:function(){return ne}});var v=e(57113),r=e(82005),F=e(72912),T=e(73742),i=e(84263),z=e(50659),P=e(41488),H=e(8152);i.ZP.config({duration:1.5});var Y=Date.now(),L=function(B){if(B.response){var ee=B.data?B.data.message||B.message||B.data:B.response.statusText,M=B.response.status;[502,504].includes(M)?H.m.push("/error"):M===401?H.m.location.pathname!=="/login"&&(i.ZP.error("\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55"),localStorage.removeItem(P.Z.authKey),H.m.push("/login")):i.ZP.error(ee)}else console.log(B.message);throw B},J=(0,z.l7)({timeout:6e4,params:{t:Y},errorHandler:L}),ie=["/api/user/login","/open/auth/token","/api/user/two-factor/login","/api/system","/api/user/init","/api/user/notification/init"];J.interceptors.request.use((le,B)=>{var ee=localStorage.getItem(P.Z.authKey);if(ee&&!ie.includes(le)){var M={Authorization:"Bearer ".concat(ee)};return{url:le,options:(0,F.Z)((0,F.Z)({},B),{},{headers:M})}}return{url:le,options:B}}),J.interceptors.response.use(function(){var le=(0,r.Z)((0,v.Z)().mark(function B(ee){var M;return(0,v.Z)().wrap(function(ce){for(;;)switch(ce.prev=ce.next){case 0:return ce.next=2,ee.clone();case 2:return M=ce.sent,ce.abrupt("return",ee);case 4:case"end":return ce.stop()}},B)}));return function(B){return le.apply(this,arguments)}}());var ne=J},73511:function(se,_,e){"use strict";e.d(_,{Z:function(){return T}});var v=e(73080),r=e(12924),F=e.n(r);function T(){var i=r.useReducer(function(H){return H+1},0),z=(0,v.Z)(i,2),P=z[1];return P}},25069:function(se,_,e){"use strict";var v=e(12924),r=e.n(v),F=e(73511),T=e(57532);function i(){var z=arguments.length>0&&arguments[0]!==void 0?arguments[0]:!0,P=(0,v.useRef)({}),H=(0,F.Z)();return(0,v.useEffect)(function(){var Y=T.ZP.subscribe(function(L){P.current=L,z&&H()});return function(){return T.ZP.unsubscribe(Y)}},[]),P.current}_.Z=i},42061:function(se,_,e){"use strict";e.d(_,{Z:function(){return xe}});var v=e(74286),r=e(86545),F=e(19803),T=e.n(F),i=e(12924),z=e(41082),P=e(74629),H=function(E){var C,p=(0,i.useContext)(z.E_),S=p.getPrefixCls,pe=p.direction,G=E.prefixCls,k=E.className,Ce=k===void 0?"":k,N=S("input-group",G),W=T()(N,(C={},(0,r.Z)(C,"".concat(N,"-lg"),E.size==="large"),(0,r.Z)(C,"".concat(N,"-sm"),E.size==="small"),(0,r.Z)(C,"".concat(N,"-compact"),E.compact),(0,r.Z)(C,"".concat(N,"-rtl"),pe==="rtl"),C),Ce),D=(0,i.useContext)(P.aM),ue=(0,i.useMemo)(function(){return(0,v.Z)((0,v.Z)({},D),{isFormItemInput:!1})},[D]);return i.createElement("span",{className:W,style:E.style,onMouseEnter:E.onMouseEnter,onMouseLeave:E.onMouseLeave,onFocus:E.onFocus,onBlur:E.onBlur},i.createElement(P.aM.Provider,{value:ue},E.children))},Y=H,L=e(38165),J=e(73080),ie=e(81602),ne={icon:{tag:"svg",attrs:{viewBox:"64 64 896 896",focusable:"false"},children:[{tag:"path",attrs:{d:"M942.2 486.2Q889.47 375.11 816.7 305l-50.88 50.88C807.31 395.53 843.45 447.4 874.7 512 791.5 684.2 673.4 766 512 766q-72.67 0-133.87-22.38L323 798.75Q408 838 512 838q288.3 0 430.2-300.3a60.29 60.29 0 000-51.5zm-63.57-320.64L836 122.88a8 8 0 00-11.32 0L715.31 232.2Q624.86 186 512 186q-288.3 0-430.2 300.3a60.3 60.3 0 000 51.5q56.69 119.4 136.5 191.41L112.48 835a8 8 0 000 11.31L155.17 889a8 8 0 0011.31 0l712.15-712.12a8 8 0 000-11.32zM149.3 512C232.6 339.8 350.7 258 512 258c54.54 0 104.13 9.36 149.12 28.39l-70.3 70.3a176 176 0 00-238.13 238.13l-83.42 83.42C223.1 637.49 183.3 582.28 149.3 512zm246.7 0a112.11 112.11 0 01146.2-106.69L401.31 546.2A112 112 0 01396 512z"}},{tag:"path",attrs:{d:"M508 624c-3.46 0-6.87-.16-10.25-.47l-52.82 52.82a176.09 176.09 0 00227.42-227.42l-52.82 52.82c.31 3.38.47 6.79.47 10.25a111.94 111.94 0 01-112 112z"}}]},name:"eye-invisible",theme:"outlined"},le=ne,B=e(1719),ee=function(E,C){return i.createElement(B.Z,(0,ie.Z)((0,ie.Z)({},E),{},{ref:C,icon:le}))};ee.displayName="EyeInvisibleOutlined";var M=i.forwardRef(ee),Pe=e(45589),ce=e(64972),he=function(a,E){var C={};for(var p in a)Object.prototype.hasOwnProperty.call(a,p)&&E.indexOf(p)<0&&(C[p]=a[p]);if(a!=null&&typeof Object.getOwnPropertySymbols=="function")for(var S=0,p=Object.getOwnPropertySymbols(a);S<p.length;S++)E.indexOf(p[S])<0&&Object.prototype.propertyIsEnumerable.call(a,p[S])&&(C[p[S]]=a[p[S]]);return C},q={click:"onClick",hover:"onMouseOver"},I=i.forwardRef(function(a,E){var C=(0,i.useState)(!1),p=(0,J.Z)(C,2),S=p[0],pe=p[1],G=function(){var W=a.disabled;W||pe(!S)},k=function(W){var D,ue=a.action,y=a.iconRender,ve=y===void 0?function(){return null}:y,U=q[ue]||"",re=ve(S),oe=(D={},(0,r.Z)(D,U,G),(0,r.Z)(D,"className","".concat(W,"-icon")),(0,r.Z)(D,"key","passwordIcon"),(0,r.Z)(D,"onMouseDown",function(te){te.preventDefault()}),(0,r.Z)(D,"onMouseUp",function(te){te.preventDefault()}),D);return i.cloneElement(i.isValidElement(re)?re:i.createElement("span",null,re),oe)},Ce=function(W){var D=W.getPrefixCls,ue=a.className,y=a.prefixCls,ve=a.inputPrefixCls,U=a.size,re=a.visibilityToggle,oe=he(a,["className","prefixCls","inputPrefixCls","size","visibilityToggle"]),de=D("input",ve),te=D("input-password",y),ge=re&&k(te),Z=T()(te,ue,(0,r.Z)({},"".concat(te,"-").concat(U),!!U)),g=(0,v.Z)((0,v.Z)({},(0,ce.Z)(oe,["suffix","iconRender"])),{type:S?"text":"password",className:Z,prefixCls:de,suffix:ge});return U&&(g.size=U),i.createElement(L.ZP,(0,v.Z)({ref:E},g))};return i.createElement(z.C,null,Ce)});I.defaultProps={action:"click",visibilityToggle:!0,iconRender:function(E){return E?i.createElement(Pe.Z,null):i.createElement(M,null)}};var Ee=I,b=e(74532),ae=e(18880),ye=e(189),Oe=e(8421),m=e(41355),s=function(a,E){var C={};for(var p in a)Object.prototype.hasOwnProperty.call(a,p)&&E.indexOf(p)<0&&(C[p]=a[p]);if(a!=null&&typeof Object.getOwnPropertySymbols=="function")for(var S=0,p=Object.getOwnPropertySymbols(a);S<p.length;S++)E.indexOf(p[S])<0&&Object.prototype.propertyIsEnumerable.call(a,p[S])&&(C[p[S]]=a[p[S]]);return C},be=i.forwardRef(function(a,E){var C,p=a.prefixCls,S=a.inputPrefixCls,pe=a.className,G=a.size,k=a.suffix,Ce=a.enterButton,N=Ce===void 0?!1:Ce,W=a.addonAfter,D=a.loading,ue=a.disabled,y=a.onSearch,ve=a.onChange,U=a.onCompositionStart,re=a.onCompositionEnd,oe=s(a,["prefixCls","inputPrefixCls","className","size","suffix","enterButton","addonAfter","loading","disabled","onSearch","onChange","onCompositionStart","onCompositionEnd"]),de=i.useContext(z.E_),te=de.getPrefixCls,ge=de.direction,Z=i.useContext(Oe.Z),g=i.useRef(!1),f=G||Z,d=i.useRef(null),l=function(c){c&&c.target&&c.type==="click"&&y&&y(c.target.value,c),ve&&ve(c)},t=function(c){var j;document.activeElement===((j=d.current)===null||j===void 0?void 0:j.input)&&c.preventDefault()},n=function(c){var j,V;y&&y((V=(j=d.current)===null||j===void 0?void 0:j.input)===null||V===void 0?void 0:V.value,c)},u=function(c){g.current||n(c)},K=te("input-search",p),w=te("input",S),A=typeof N=="boolean"?i.createElement(b.Z,null):null,Q="".concat(K,"-button"),R,O=N||{},X=O.type&&O.type.__ANT_BUTTON===!0;X||O.type==="button"?R=(0,m.Tm)(O,(0,v.Z)({onMouseDown:t,onClick:function(c){var j,V;(V=(j=O==null?void 0:O.props)===null||j===void 0?void 0:j.onClick)===null||V===void 0||V.call(j,c),n(c)},key:"enterButton"},X?{className:Q,size:f}:{})):R=i.createElement(ye.Z,{className:Q,type:N?"primary":void 0,size:f,disabled:ue,key:"enterButton",onMouseDown:t,onClick:n,loading:D,icon:A},N),W&&(R=[R,(0,m.Tm)(W,{key:"addonAfter"})]);var h=T()(K,(C={},(0,r.Z)(C,"".concat(K,"-rtl"),ge==="rtl"),(0,r.Z)(C,"".concat(K,"-").concat(f),!!f),(0,r.Z)(C,"".concat(K,"-with-button"),!!N),C),pe),x=function(c){g.current=!0,U==null||U(c)},$=function(c){g.current=!1,re==null||re(c)};return i.createElement(L.ZP,(0,v.Z)({ref:(0,ae.sQ)(d,E),onPressEnter:u},oe,{size:f,onCompositionStart:x,onCompositionEnd:$,prefixCls:w,addonAfter:R,suffix:k,onChange:l,className:h,disabled:ue}))}),Ne=be,Se=e(26135),me=L.ZP;me.Group=Y,me.Search=Ne,me.TextArea=Se.Z,me.Password=Ee;var xe=me},42857:function(se,_,e){"use strict";var v=e(86545),r=e(74286),F=e(19803),T=e.n(F),i=e(47102),z=e(64972),P=e(12924),H=e.n(P),Y=e(41082),L=e(19931),J=e(75091),ie=e(8421),ne=e(74629),le=e(46403),B=e(23229),ee=e(6105),M=function(q,I){var Ee={};for(var b in q)Object.prototype.hasOwnProperty.call(q,b)&&I.indexOf(b)<0&&(Ee[b]=q[b]);if(q!=null&&typeof Object.getOwnPropertySymbols=="function")for(var ae=0,b=Object.getOwnPropertySymbols(q);ae<b.length;ae++)I.indexOf(b[ae])<0&&Object.prototype.propertyIsEnumerable.call(q,b[ae])&&(Ee[b[ae]]=q[b[ae]]);return Ee},Pe="SECRET_COMBOBOX_MODE_DO_NOT_USE",ce=function(I,Ee){var b,ae=I.prefixCls,ye=I.bordered,Oe=ye===void 0?!0:ye,m=I.className,s=I.getPopupContainer,be=I.dropdownClassName,Ne=I.listHeight,Se=Ne===void 0?256:Ne,me=I.placement,xe=I.listItemHeight,a=xe===void 0?24:xe,E=I.size,C=I.disabled,p=I.notFoundContent,S=I.status,pe=I.showArrow,G=M(I,["prefixCls","bordered","className","getPopupContainer","dropdownClassName","listHeight","placement","listItemHeight","size","disabled","notFoundContent","status","showArrow"]),k=P.useContext(Y.E_),Ce=k.getPopupContainer,N=k.getPrefixCls,W=k.renderEmpty,D=k.direction,ue=k.virtual,y=k.dropdownMatchSelectWidth,ve=P.useContext(ie.Z),U=N("select",ae),re=N(),oe=P.useMemo(function(){var o=G.mode;if(o!=="combobox")return o===Pe?"combobox":o},[G.mode]),de=oe==="multiple"||oe==="tags",te=pe!==void 0?pe:G.loading||!(de||oe==="combobox"),ge=(0,P.useContext)(ne.aM),Z=ge.status,g=ge.hasFeedback,f=ge.isFormItemInput,d=ge.feedbackIcon,l=(0,B.F)(Z,S),t;p!==void 0?t=p:oe==="combobox"?t=null:t=(W||L.Z)("Select");var n=(0,ee.Z)((0,r.Z)((0,r.Z)({},G),{multiple:de,hasFeedback:g,feedbackIcon:d,showArrow:te,prefixCls:U})),u=n.suffixIcon,K=n.itemIcon,w=n.removeIcon,A=n.clearIcon,Q=(0,z.Z)(G,["suffixIcon","itemIcon"]),R=T()(be,(0,v.Z)({},"".concat(U,"-dropdown-").concat(D),D==="rtl")),O=E||ve,X=P.useContext(J.Z),h=C||X,x=T()((b={},(0,v.Z)(b,"".concat(U,"-lg"),O==="large"),(0,v.Z)(b,"".concat(U,"-sm"),O==="small"),(0,v.Z)(b,"".concat(U,"-rtl"),D==="rtl"),(0,v.Z)(b,"".concat(U,"-borderless"),!Oe),(0,v.Z)(b,"".concat(U,"-in-form-item"),f),b),(0,B.Z)(U,l,g),m),$=function(){return me!==void 0?me:D==="rtl"?"bottomRight":"bottomLeft"};return P.createElement(i.ZP,(0,r.Z)({ref:Ee,virtual:ue,dropdownMatchSelectWidth:y},Q,{transitionName:(0,le.mL)(re,(0,le.q0)(me),G.transitionName),listHeight:Se,listItemHeight:a,mode:oe,prefixCls:U,placement:$(),direction:D,inputIcon:u,menuItemSelectedIcon:K,removeIcon:w,clearIcon:A,notFoundContent:t,className:x,getPopupContainer:s||Ce,dropdownClassName:R,showArrow:g||pe,disabled:h}))},he=P.forwardRef(ce);he.SECRET_COMBOBOX_MODE_DO_NOT_USE=Pe,he.Option=i.Wx,he.OptGroup=i.Xo,_.Z=he},98593:function(se,_){"use strict";var e={MAC_ENTER:3,BACKSPACE:8,TAB:9,NUM_CENTER:12,ENTER:13,SHIFT:16,CTRL:17,ALT:18,PAUSE:19,CAPS_LOCK:20,ESC:27,SPACE:32,PAGE_UP:33,PAGE_DOWN:34,END:35,HOME:36,LEFT:37,UP:38,RIGHT:39,DOWN:40,PRINT_SCREEN:44,INSERT:45,DELETE:46,ZERO:48,ONE:49,TWO:50,THREE:51,FOUR:52,FIVE:53,SIX:54,SEVEN:55,EIGHT:56,NINE:57,QUESTION_MARK:63,A:65,B:66,C:67,D:68,E:69,F:70,G:71,H:72,I:73,J:74,K:75,L:76,M:77,N:78,O:79,P:80,Q:81,R:82,S:83,T:84,U:85,V:86,W:87,X:88,Y:89,Z:90,META:91,WIN_KEY_RIGHT:92,CONTEXT_MENU:93,NUM_ZERO:96,NUM_ONE:97,NUM_TWO:98,NUM_THREE:99,NUM_FOUR:100,NUM_FIVE:101,NUM_SIX:102,NUM_SEVEN:103,NUM_EIGHT:104,NUM_NINE:105,NUM_MULTIPLY:106,NUM_PLUS:107,NUM_MINUS:109,NUM_PERIOD:110,NUM_DIVISION:111,F1:112,F2:113,F3:114,F4:115,F5:116,F6:117,F7:118,F8:119,F9:120,F10:121,F11:122,F12:123,NUMLOCK:144,SEMICOLON:186,DASH:189,EQUALS:187,COMMA:188,PERIOD:190,SLASH:191,APOSTROPHE:192,SINGLE_QUOTE:222,OPEN_SQUARE_BRACKET:219,BACKSLASH:220,CLOSE_SQUARE_BRACKET:221,WIN_KEY:224,MAC_FF_META:224,WIN_IME:229,isTextModifyingKeyEvent:function(r){var F=r.keyCode;if(r.altKey&&!r.ctrlKey||r.metaKey||F>=e.F1&&F<=e.F12)return!1;switch(F){case e.ALT:case e.CAPS_LOCK:case e.CONTEXT_MENU:case e.CTRL:case e.DOWN:case e.END:case e.ESC:case e.HOME:case e.INSERT:case e.LEFT:case e.MAC_FF_META:case e.META:case e.NUMLOCK:case e.NUM_CENTER:case e.PAGE_DOWN:case e.PAGE_UP:case e.PAUSE:case e.PRINT_SCREEN:case e.RIGHT:case e.SHIFT:case e.UP:case e.WIN_KEY:case e.WIN_KEY_RIGHT:return!1;default:return!0}},isCharacterKey:function(r){if(r>=e.ZERO&&r<=e.NINE||r>=e.NUM_ZERO&&r<=e.NUM_MULTIPLY||r>=e.A&&r<=e.Z||window.navigator.userAgent.indexOf("WebKit")!==-1&&r===0)return!0;switch(r){case e.SPACE:case e.QUESTION_MARK:case e.NUM_PLUS:case e.NUM_MINUS:case e.NUM_PERIOD:case e.NUM_DIVISION:case e.SEMICOLON:case e.DASH:case e.EQUALS:case e.COMMA:case e.PERIOD:case e.SLASH:case e.APOSTROPHE:case e.SINGLE_QUOTE:case e.OPEN_SQUARE_BRACKET:case e.BACKSLASH:case e.CLOSE_SQUARE_BRACKET:return!0;default:return!1}}};_.Z=e},73835:function(se,_,e){"use strict";e.d(_,{Z:function(){return H}});var v=e(81602),r=`accept acceptCharset accessKey action allowFullScreen allowTransparency
    alt async autoComplete autoFocus autoPlay capture cellPadding cellSpacing challenge
    charSet checked classID className colSpan cols content contentEditable contextMenu
    controls coords crossOrigin data dateTime default defer dir disabled download draggable
    encType form formAction formEncType formMethod formNoValidate formTarget frameBorder
    headers height hidden high href hrefLang htmlFor httpEquiv icon id inputMode integrity
    is keyParams keyType kind label lang list loop low manifest marginHeight marginWidth max maxLength media
    mediaGroup method min minLength multiple muted name noValidate nonce open
    optimum pattern placeholder poster preload radioGroup readOnly rel required
    reversed role rowSpan rows sandbox scope scoped scrolling seamless selected
    shape size sizes span spellCheck src srcDoc srcLang srcSet start step style
    summary tabIndex target title type useMap value width wmode wrap`,F=`onCopy onCut onPaste onCompositionEnd onCompositionStart onCompositionUpdate onKeyDown
    onKeyPress onKeyUp onFocus onBlur onChange onInput onSubmit onClick onContextMenu onDoubleClick
    onDrag onDragEnd onDragEnter onDragExit onDragLeave onDragOver onDragStart onDrop onMouseDown
    onMouseEnter onMouseLeave onMouseMove onMouseOut onMouseOver onMouseUp onSelect onTouchCancel
    onTouchEnd onTouchMove onTouchStart onScroll onWheel onAbort onCanPlay onCanPlayThrough
    onDurationChange onEmptied onEncrypted onEnded onError onLoadedData onLoadedMetadata
    onLoadStart onPause onPlay onPlaying onProgress onRateChange onSeeked onSeeking onStalled onSuspend onTimeUpdate onVolumeChange onWaiting onLoad onError`,T="".concat(r," ").concat(F).split(/[\s\n]+/),i="aria-",z="data-";function P(Y,L){return Y.indexOf(L)===0}function H(Y){var L=arguments.length>1&&arguments[1]!==void 0?arguments[1]:!1,J;L===!1?J={aria:!0,data:!0,attr:!0}:L===!0?J={aria:!0}:J=(0,v.Z)({},L);var ie={};return Object.keys(Y).forEach(function(ne){(J.aria&&(ne==="role"||P(ne,i))||J.data&&P(ne,z)||J.attr&&T.includes(ne))&&(ie[ne]=Y[ne])}),ie}},71129:function(){}}]);
