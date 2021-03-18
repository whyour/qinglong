import { defineConfig } from 'umi';
import {
  SmileOutlined,
  CrownOutlined,
  TabletOutlined,
  AntDesignOutlined,
} from '@ant-design/icons';

export default defineConfig({
  antd: {
    compact: true,
  },
  hash: true,
  layout: false,
  locale: {},
  nodeModulesTransform: {
    type: 'none',
  },
  fastRefresh: {},
  favicon: 'http://demo.sc.chinaz.com/Files/pic/iconsico/8002/g5.ico',
  proxy: {
    '/api': {
      target: 'http://127.0.0.1:5678/',
      changeOrigin: true,
    },
  },
});
