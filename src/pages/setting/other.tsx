import React, { useState, useEffect } from 'react';
import { Button, InputNumber, Form, Radio, message, Input } from 'antd';
import * as DarkReader from '@umijs/ssr-darkreader';
import config from '@/utils/config';
import { request } from '@/utils/http';
import CheckUpdate from './checkUpdate';
import { SharedContext } from '@/layouts';
import './index.less';

const optionsWithDisabled = [
  { label: '亮色', value: 'light' },
  { label: '暗色', value: 'dark' },
  { label: '跟随系统', value: 'auto' },
];

const Other = ({
  systemInfo,
  socketMessage,
  reloadTheme,
}: Pick<SharedContext, 'socketMessage' | 'reloadTheme' | 'systemInfo'>) => {
  const defaultTheme = localStorage.getItem('qinglong_dark_theme') || 'auto';
  const [systemConfig, setSystemConfig] = useState<{
    logRemoveFrequency?: number | null;
    cronConcurrency?: number | null;
  }>();
  const [form] = Form.useForm();

  const {
    enable: enableDarkMode,
    disable: disableDarkMode,
    exportGeneratedCSS: collectCSS,
    setFetchMethod,
    auto: followSystemColorScheme,
  } = DarkReader || {};

  const themeChange = (e: any) => {
    const _theme = e.target.value;
    localStorage.setItem('qinglong_dark_theme', e.target.value);
    setFetchMethod(fetch);

    if (_theme === 'dark') {
      enableDarkMode({});
    } else if (_theme === 'light') {
      disableDarkMode();
    } else {
      followSystemColorScheme({});
    }
    reloadTheme();
  };

  const getSystemConfig = () => {
    request
      .get(`${config.apiPrefix}system/config`)
      .then(({ code, data }) => {
        if (code === 200 && data.info) {
          setSystemConfig(data.info);
        }
      })
      .catch((error: any) => {
        console.log(error);
      });
  };

  const updateSystemConfig = () => {
    request
      .put(`${config.apiPrefix}system/config`, {
        data: { ...systemConfig },
      })
      .then(({ code, data }) => {
        if (code === 200) {
          message.success('更新成功');
        }
      })
      .catch((error: any) => {
        console.log(error);
      });
  };

  useEffect(() => {
    getSystemConfig();
  }, []);

  return (
    <Form layout="vertical" form={form}>
      <Form.Item label="主题设置" name="theme" initialValue={defaultTheme}>
        <Radio.Group
          options={optionsWithDisabled}
          onChange={themeChange}
          value={defaultTheme}
          optionType="button"
          buttonStyle="solid"
        />
      </Form.Item>
      <Form.Item
        label="日志删除频率"
        name="frequency"
        tooltip="每x天自动删除x天以前的日志"
      >
        <Input.Group compact>
          <InputNumber
            addonBefore="每"
            addonAfter="天"
            style={{ width: 142 }}
            min={0}
            value={systemConfig?.logRemoveFrequency}
            onChange={(value) => {
              setSystemConfig({ ...systemConfig, logRemoveFrequency: value });
            }}
          />
          <Button type="primary" onClick={updateSystemConfig}>
            确认
          </Button>
        </Input.Group>
      </Form.Item>
      <Form.Item label="定时任务并发数" name="frequency">
        <Input.Group compact>
          <InputNumber
            style={{ width: 142 }}
            min={1}
            value={systemConfig?.cronConcurrency}
            onChange={(value) => {
              setSystemConfig({ ...systemConfig, cronConcurrency: value });
            }}
          />
          <Button type="primary" onClick={updateSystemConfig}>
            确认
          </Button>
        </Input.Group>
      </Form.Item>
      <Form.Item label="检查更新" name="update">
        <CheckUpdate systemInfo={systemInfo} socketMessage={socketMessage} />
      </Form.Item>
    </Form>
  );
};

export default Other;
