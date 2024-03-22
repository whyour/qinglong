import intl from 'react-intl-universal';
import React, { useState, useEffect, useRef } from 'react';
import {
  Button,
  InputNumber,
  Form,
  Radio,
  message,
  Input,
  Upload,
  Modal,
  Select,
} from 'antd';
import * as DarkReader from '@umijs/ssr-darkreader';
import config from '@/utils/config';
import { request } from '@/utils/http';
import CheckUpdate from './checkUpdate';
import { SharedContext } from '@/layouts';
import { saveAs } from 'file-saver';
import './index.less';
import { UploadOutlined } from '@ant-design/icons';
import Countdown from 'antd/lib/statistic/Countdown';
import useProgress from './progress';
import pick from 'lodash/pick';
import { disableBody } from '@/utils';

const dataMap = {
  'log-remove-frequency': 'logRemoveFrequency',
  'cron-concurrency': 'cronConcurrency',
};

const Other = ({
  systemInfo,
  reloadTheme,
}: Pick<SharedContext, 'reloadTheme' | 'systemInfo'>) => {
  const defaultTheme = localStorage.getItem('qinglong_dark_theme') || 'auto';
  const [systemConfig, setSystemConfig] = useState<{
    logRemoveFrequency?: number | null;
    cronConcurrency?: number | null;
  }>();
  const [form] = Form.useForm();
  const [exportLoading, setExportLoading] = useState(false);
  const showUploadProgress = useProgress(intl.get('上传'));
  const showDownloadProgress = useProgress(intl.get('下载'));

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

  const handleLangChange = (v: string) => {
    localStorage.setItem('lang', v);
    setTimeout(() => {
      window.location.reload();
    }, 500);
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

  const updateSystemConfig = (path: keyof typeof dataMap) => {
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

  const exportData = () => {
    setExportLoading(true);
    request
      .put<Blob>(
        `${config.apiPrefix}system/data/export`,
        {},
        {
          responseType: 'blob',
          timeout: 86400000,
          onDownloadProgress: (e) => {
            if (e.progress) {
              showDownloadProgress(parseFloat((e.progress * 100).toFixed(1)));
            }
          },
        },
      )
      .then((res) => {
        saveAs(res, 'data.tgz');
      })
      .catch((error: any) => {
        console.log(error);
      })
      .finally(() => setExportLoading(false));
  };

  const showReloadModal = () => {
    Modal.confirm({
      width: 600,
      maskClosable: false,
      title: intl.get('确认重启'),
      centered: true,
      content: (
        <>
          <div>{intl.get('备份数据上传成功，确认覆盖数据')}</div>
          <div>{intl.get('如果恢复失败，可进入容器执行')} ql reload data</div>
        </>
      ),
      okText: intl.get('重启'),
      onOk() {
        request
          .put(`${config.apiPrefix}update/data`)
          .then(() => {
            message.success({
              content: (
                <span>
                  {intl.get('系统将在')}
                  <Countdown
                    className="inline-countdown"
                    format="ss"
                    value={Date.now() + 1000 * 30}
                  />
                  {intl.get('秒后自动刷新')}
                </span>
              ),
              duration: 30,
            });
            disableBody();
            setTimeout(() => {
              window.location.reload();
            }, 30000);
          })
          .catch((error: any) => {
            console.log(error);
          });
      },
    });
  };

  useEffect(() => {
    getSystemConfig();
  }, []);

  return (
    <Form layout="vertical" form={form}>
      <Form.Item
        label={intl.get('主题')}
        name="theme"
        initialValue={defaultTheme}
      >
        <Radio.Group
          onChange={themeChange}
          value={defaultTheme}
          optionType="button"
          buttonStyle="solid"
        >
          <Radio.Button
            value="light"
            style={{ width: 70, textAlign: 'center' }}
          >
            {intl.get('亮色')}
          </Radio.Button>
          <Radio.Button value="dark" style={{ width: 66, textAlign: 'center' }}>
            {intl.get('暗色')}
          </Radio.Button>
          <Radio.Button
            value="auto"
            style={{ width: 129, textAlign: 'center' }}
          >
            {intl.get('跟随系统')}
          </Radio.Button>
        </Radio.Group>
      </Form.Item>
      <Form.Item
        label={intl.get('日志删除频率')}
        name="frequency"
        tooltip={intl.get('每x天自动删除x天以前的日志')}
      >
        <Input.Group compact>
          <InputNumber
            addonBefore={intl.get('每')}
            addonAfter={intl.get('天')}
            style={{ width: 180 }}
            min={0}
            value={systemConfig?.logRemoveFrequency}
            onChange={(value) => {
              setSystemConfig({ ...systemConfig, logRemoveFrequency: value });
            }}
          />
          <Button
            type="primary"
            onClick={() => {
              updateSystemConfig('log-remove-frequency');
            }}
            style={{ width: 84 }}
          >
            {intl.get('确认')}
          </Button>
        </Input.Group>
      </Form.Item>
      <Form.Item label={intl.get('定时任务并发数')} name="frequency">
        <Input.Group compact>
          <InputNumber
            style={{ width: 180 }}
            min={1}
            value={systemConfig?.cronConcurrency}
            onChange={(value) => {
              setSystemConfig({ ...systemConfig, cronConcurrency: value });
            }}
          />
          <Button
            type="primary"
            onClick={() => {
              updateSystemConfig('cron-concurrency');
            }}
            style={{ width: 84 }}
          >
            {intl.get('确认')}
          </Button>
        </Input.Group>
      </Form.Item>
      <Form.Item label={intl.get('语言')} name="lang">
        <Select
          defaultValue={localStorage.getItem('lang') || ''}
          style={{ width: 264 }}
          onChange={handleLangChange}
          options={[
            { value: '', label: intl.get('跟随系统') },
            { value: 'zh', label: '简体中文' },
            { value: 'en', label: 'English' },
          ]}
        />
      </Form.Item>
      <Form.Item label={intl.get('数据备份还原')} name="frequency">
        <Button type="primary" onClick={exportData} loading={exportLoading}>
          {exportLoading ? intl.get('生成数据中...') : intl.get('备份')}
        </Button>
        <Upload
          method="put"
          showUploadList={false}
          maxCount={1}
          action={`${config.apiPrefix}system/data/import`}
          onChange={({ file, event }) => {
            if (event?.percent) {
              showUploadProgress(
                Math.min(parseFloat(event?.percent.toFixed(1)), 99),
              );
            }
            if (file.status === 'done') {
              showUploadProgress(100);
              showReloadModal();
            }
            if (file.status === 'error') {
              message.error('上传失败');
            }
          }}
          name="data"
          headers={{
            Authorization: `Bearer ${localStorage.getItem(config.authKey)}`,
          }}
        >
          <Button icon={<UploadOutlined />} style={{ marginLeft: 8 }}>
            {intl.get('还原数据')}
          </Button>
        </Upload>
      </Form.Item>
      <Form.Item label={intl.get('检查更新')} name="update">
        <CheckUpdate systemInfo={systemInfo} />
      </Form.Item>
    </Form>
  );
};

export default Other;
