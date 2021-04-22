import { defineConfig } from 'umi';
const CompressionPlugin = require('compression-webpack-plugin');

export default defineConfig({
  hash: true,
  layout: false,
  nodeModulesTransform: {
    type: 'none',
  },
  fastRefresh: {},
  favicon: 'https://qinglong.whyour.cn/g5.ico',
  proxy: {
    '/api': {
      target: 'http://127.0.0.1:5678/',
      changeOrigin: true,
    },
  },
  chainWebpack: (config) => {
    config.plugin('compression-webpack-plugin').use(
      new CompressionPlugin({
        algorithm: 'gzip',
        test: new RegExp('\\.(js|css)$'),
        threshold: 10240,
        minRatio: 0.6,
      }),
    );
  },
  externals: {
    react: 'window.React',
    'react-dom': 'window.ReactDOM',
    codemirror: 'window.CodeMirror',
    darkreader: 'window.DarkReader',
  },
  scripts: [
    'https://gw.alipayobjects.com/os/lib/react/16.13.1/umd/react.production.min.js',
    'https://gw.alipayobjects.com/os/lib/react-dom/16.13.1/umd/react-dom.production.min.js',
    'https://cdn.jsdelivr.net/npm/codemirror@5.60.0/lib/codemirror.min.js',
    'https://cdn.jsdelivr.net/npm/darkreader@4.9.27/darkreader.min.js',
    'https://cdn.jsdelivr.net/npm/codemirror@5.60.0/mode/shell/shell.js',
  ],
});
