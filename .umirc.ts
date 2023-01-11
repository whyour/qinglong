import { defineConfig } from '@umijs/max';
const CompressionPlugin = require('compression-webpack-plugin');

export default defineConfig({
  hash: true,
  antd: {},
  outputPath: 'static/dist',
  fastRefresh: true,
  favicons: ['./images/favicon.svg'],
  mfsu: {
    strategy: 'eager',
  },
  publicPath: process.env.NODE_ENV === 'production' ? './' : '/',
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
  chainWebpack: ((config: any) => {
    config.plugin('compression-webpack-plugin').use(
      new CompressionPlugin({
        algorithm: 'gzip',
        test: new RegExp('\\.(js|css)$'),
        threshold: 10240,
        minRatio: 0.6,
      }),
    );
  }) as any,
  externals: {
    react: 'window.React',
    'react-dom': 'window.ReactDOM',
  },
  headScripts: [
    'https://gw.alipayobjects.com/os/lib/react/18.2.0/umd/react.production.min.js',
    'https://gw.alipayobjects.com/os/lib/react-dom/18.2.0/umd/react-dom.production.min.js',
  ],
});
