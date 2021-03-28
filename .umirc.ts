import { defineConfig } from 'umi';

export default defineConfig({
  hash: true,
  layout: false,
  nodeModulesTransform: {
    type: 'none',
  },
  fastRefresh: {},
  favicon: 'https://image.whyour.cn/others/g5.ico',
  proxy: {
    '/api': {
      target: 'http://127.0.0.1:5678/',
      changeOrigin: true,
    },
  },
});
