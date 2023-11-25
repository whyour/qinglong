import intl from 'react-intl-universal';
import React, { useState, useEffect, useRef } from 'react';
import { Button, InputNumber, Form, message, Input, Alert } from 'antd';
import config from '@/utils/config';
import { request } from '@/utils/http';
import './index.less';
import Ansi from 'ansi-to-react';
import pick from 'lodash/pick';

const dataMap = {
  'dependence-proxy': 'dependenceProxy',
  'node-mirror': 'nodeMirror',
  'python-mirror': 'pythonMirror',
  'linux-mirror': 'linuxMirror',
};

const Dependence = () => {
  const [systemConfig, setSystemConfig] = useState<{
    dependenceProxy?: string;
    nodeMirror?: string;
    pythonMirror?: string;
    linuxMirror?: string;
  }>();
  const [form] = Form.useForm();
  const [log, setLog] = useState<string>('');

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

  const updateSystemConfigStream = (path: keyof typeof dataMap) => {
    setLog('执行中...');
    request
      .put<string>(
        `${config.apiPrefix}system/config/${path}`,
        pick(systemConfig, dataMap[path]),
        {
          responseType: 'stream',
        },
      )
      .then((res) => {
        setLog(() => res);
      })
      .catch((error: any) => {
        console.log(error);
      });
  };

  const updateSystemConfig = (path: keyof typeof dataMap) => {
    setLog('');
    request
      .put(
        `${config.apiPrefix}system/config/${path}`,
        pick(systemConfig, dataMap[path]),
      )
      .then(({ code, data }) => {
        if (code === 200) {
          message.success(intl.get('更新成功'));
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
    <div className="dependence-config-wrapper">
      <Form layout="vertical" form={form}>
        <Form.Item
          label={intl.get('代理')}
          name="proxy"
          extra={intl.get('代理与镜像源二选一即可')}
        >
          <Input.Group compact>
            <Input
              placeholder={intl.get('代理地址, 支持HTTP(S)/SOCK5')}
              style={{ width: 330 }}
              value={systemConfig?.dependenceProxy}
              onChange={(e) => {
                setSystemConfig({
                  ...systemConfig,
                  dependenceProxy: e.target.value,
                });
              }}
            />
            <Button
              type="primary"
              onClick={() => {
                updateSystemConfig('dependence-proxy');
              }}
              style={{ width: 84 }}
            >
              {intl.get('确认')}
            </Button>
          </Input.Group>
        </Form.Item>
        <Form.Item label={intl.get('Node 软件包镜像源')} name="node">
          <Input.Group compact>
            <Input
              style={{ width: 330 }}
              placeholder={intl.get('NPM 镜像源')}
              value={systemConfig?.nodeMirror}
              onChange={(e) => {
                setSystemConfig({
                  ...systemConfig,
                  nodeMirror: e.target.value,
                });
              }}
            />
            <Button
              type="primary"
              onClick={() => {
                updateSystemConfigStream('node-mirror');
              }}
              style={{ width: 84 }}
            >
              {intl.get('确认')}
            </Button>
          </Input.Group>
        </Form.Item>
        <Form.Item label={intl.get('Python 软件包镜像源')} name="python">
          <Input.Group compact>
            <Input
              style={{ width: 330 }}
              placeholder={intl.get('PyPI 镜像源')}
              value={systemConfig?.pythonMirror}
              onChange={(e) => {
                setSystemConfig({
                  ...systemConfig,
                  pythonMirror: e.target.value,
                });
              }}
            />
            <Button
              type="primary"
              onClick={() => {
                updateSystemConfig('python-mirror');
              }}
              style={{ width: 84 }}
            >
              {intl.get('确认')}
            </Button>
          </Input.Group>
        </Form.Item>
        <Form.Item label={intl.get('Linux 软件包镜像源')} name="linux">
          <Input.Group compact>
            <Input
              style={{ width: 330 }}
              placeholder={intl.get('alpine linux 镜像源')}
              value={systemConfig?.linuxMirror}
              onChange={(e) => {
                setSystemConfig({
                  ...systemConfig,
                  linuxMirror: e.target.value,
                });
              }}
            />
            <Button
              type="primary"
              onClick={() => {
                updateSystemConfigStream('linux-mirror');
              }}
              style={{ width: 84 }}
            >
              {intl.get('确认')}
            </Button>
          </Input.Group>
        </Form.Item>
      </Form>
      <pre
        style={{
          fontFamily: 'Source Code Pro',
          zoom: 0.83,
          maxHeight: '100%',
          overflowY: 'auto'
        }}
      >
        <Ansi>{log}</Ansi>
      </pre>
    </div>
  );
};

export default Dependence;
