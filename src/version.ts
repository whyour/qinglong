export const version = '2.10.10';
export const changeLogLink = 'https://t.me/jiao_long/229';
export const changeLog = `2.10.10 版本说明
1. 检测更新增加强制更新操作
2. deps目录文件增加软链，支持脚本直接调用。比如 const notify = require('deps/sendNotify')
3. 修复alpine3.12和3.14关于nginx的兼容性问题
4. 修复调试脚本运行路径
5. 修复deps目录依赖文件拷贝
6. 修复使用旧pushplus推送后结果解析失败的问题，感谢 https://github.com/xuzhonglin
`;
