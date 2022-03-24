export const version = '2.12.0';
export const changeLogLink = 'https://t.me/jiao_long/288';
export const changeLog = `2.12.0 版本说明
1. 全新定时任务详情，支持日志查看、脚本编辑
2. openapi增加发送通知接口，可用于脚本直接调用
3. 增加pushDeer推送，感谢 https://github.com/NekoMio PR
4. 增加public服务，当服务异常时，查询服务状态及日志，供页面使用。
5. 增加ql check可视化错误提示
6. 修改openapi获取token逻辑，最多存储5个可用的token。
7. 调整数据目录，log、db、scripts、config等目录迁移到 /ql/data 目录，docker映射只需映射data目录
8. 版本文件存储到七牛云，方便检查更新
9. 修复编辑应用初始值
10. 修复退出登录和定时任务搜索
11. 其他bug修复
`;
