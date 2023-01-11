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
  const [logRemoveFrequency, setLogRemoveFrequency] = useState<number | null>();
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

  const getLogRemoveFrequency = () => {
    request
      .get(`${config.apiPrefix}system/log/remove`)
      .then(({ code, data }) => {
        if (code === 200 && data.info) {
          const { frequency } = data.info;
          setLogRemoveFrequency(frequency);
        }
      })
      .catch((error: any) => {
        console.log(error);
      });
  };

  const updateRemoveLogFrequency = () => {
    setTimeout(() => {
      request
        .put(`${config.apiPrefix}system/log/remove`, {
          data: { frequency: logRemoveFrequency },
        })
        .then(({ code, data }) => {
          if (code === 200) {
            message.success('更新成功');
          }
        })
        .catch((error: any) => {
          console.log(error);
        });
    });
  };

  useEffect(() => {
    getLogRemoveFrequency();
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
            style={{ width: 150 }}
            min={0}
            value={logRemoveFrequency}
            onChange={(value) => setLogRemoveFrequency(value)}
          />
          <Button type="primary" onClick={updateRemoveLogFrequency}>
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
