import { defineConfig } from 'umi';
const CompressionPlugin = require('compression-webpack-plugin');

export default defineConfig({
  hash: true,
  layout: false,
  outputPath: 'static/dist',
  nodeModulesTransform: {
    type: 'none',
  },
  fastRefresh: {},
  esbuild: {},
  webpack5: {},
  dynamicImport: {
    loading: '@/components/pageLoading',
  },
  favicon: '/images/g5.ico',
  proxy: {
    '/api/public': {
      target: 'http://127.0.0.1:5400/',
      changeOrigin: true,
    },
    '/api': {
      target: 'http://127.0.0.1:5600/',
      changeOrigin: true,
      ws: true,
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
  },
  scripts: [
    'https://gw.alipayobjects.com/os/lib/react/16.13.1/umd/react.production.min.js',
    'https://gw.alipayobjects.com/os/lib/react-dom/16.13.1/umd/react-dom.production.min.js',
  ],
});
