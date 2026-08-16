import React, { useEffect, useState } from 'react';
import intl from 'react-intl-universal';
import {
  Alert,
  Button,
  Descriptions,
  Input,
  InputNumber,
  Radio,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import config from '@/utils/config';
import { request } from '@/utils/http';

const { Paragraph, Text } = Typography;

type TrustProxySource = 'default' | 'system' | 'environment';
type TrustProxyMode = 'direct' | 'single' | 'hops' | 'custom';

interface TrustProxyConfig {
  trustProxy: string;
  source: TrustProxySource;
  editable: boolean;
}

interface ClientIpDiagnostic extends TrustProxyConfig {
  remoteAddress: string;
  forwardedFor: string[];
  expressIps: string[];
  clientIp: string;
  hops: Array<{
    ip: string;
    hop: number;
    status: 'trusted' | 'client' | 'not_checked';
  }>;
}

function parseSetting(setting: string) {
  if (setting === 'false' || setting === '0') {
    return { mode: 'direct' as const, hops: 2, custom: '' };
  }
  if (setting === '1') {
    return { mode: 'single' as const, hops: 2, custom: '' };
  }
  if (/^\d+$/.test(setting)) {
    return { mode: 'hops' as const, hops: Number(setting), custom: '' };
  }
  return { mode: 'custom' as const, hops: 2, custom: setting };
}

const ClientIp = () => {
  const [configInfo, setConfigInfo] = useState<TrustProxyConfig>();
  const [diagnostic, setDiagnostic] = useState<ClientIpDiagnostic>();
  const [mode, setMode] = useState<TrustProxyMode>('direct');
  const [hops, setHops] = useState(2);
  const [custom, setCustom] = useState('');
  const [saving, setSaving] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);

  const applyConfig = (data: TrustProxyConfig) => {
    setConfigInfo(data);
    const parsed = parseSetting(data.trustProxy);
    setMode(parsed.mode);
    setHops(parsed.hops);
    setCustom(parsed.custom);
  };

  const getConfig = async () => {
    const response = await request.get(
      `${config.apiPrefix}system/client-ip/config`,
    );
    if (response.code === 200) {
      applyConfig(response.data);
    }
  };

  const diagnose = async () => {
    setDiagnosing(true);
    try {
      const response = await request.get(
        `${config.apiPrefix}system/client-ip/diagnose`,
      );
      if (response.code === 200) {
        setDiagnostic(response.data);
      }
    } finally {
      setDiagnosing(false);
    }
  };

  const getSetting = () => {
    if (mode === 'direct') return 'false';
    if (mode === 'single') return '1';
    if (mode === 'hops') return String(hops);
    return custom.trim();
  };

  const save = async () => {
    const trustProxy = getSetting();
    if (!trustProxy) {
      message.error(intl.get('请输入可信代理地址或网段'));
      return;
    }
    setSaving(true);
    try {
      const response = await request.put(
        `${config.apiPrefix}system/client-ip/config`,
        { trustProxy },
      );
      if (response.code === 200) {
        applyConfig(response.data);
        message.success(intl.get('更新成功'));
        await diagnose();
      }
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    getConfig();
    diagnose();
  }, []);

  const sourceMap: Record<TrustProxySource, string> = {
    default: intl.get('默认配置'),
    system: intl.get('系统设置'),
    environment: intl.get('环境变量'),
  };
  const statusMap = {
    trusted: { color: 'green', text: intl.get('可信代理') },
    client: { color: 'blue', text: intl.get('最终客户端') },
    not_checked: { color: 'default', text: intl.get('未检查') },
  };

  return (
    <div style={{ maxWidth: 960, padding: '12px 0 32px' }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message={intl.get('可信代理配置说明')}
          description={
            <div>
              <Paragraph>
                {intl.get(
                  '系统从离青龙最近的一跳开始，由右向左检查代理链，并把第一个不可信地址作为客户端 IP。',
                )}
              </Paragraph>
              <Paragraph style={{ marginBottom: 0 }}>
                {intl.get(
                  '代理层数只适合所有访问路径长度完全一致的部署；生产环境更推荐填写代理的固定 IP 或专用网络 CIDR。不要直接使用 true。',
                )}
              </Paragraph>
            </div>
          }
        />

        {configInfo?.source === 'environment' && (
          <Alert
            type="warning"
            showIcon
            message={intl.get('当前由环境变量 QL_TRUST_PROXY 管理')}
            description={intl.get(
              '请修改容器环境变量并重启，系统设置不能覆盖环境变量。',
            )}
          />
        )}

        <div>
          <Paragraph strong>{intl.get('Trust Proxy 自定义设置')}</Paragraph>
          <Radio.Group
            value={mode}
            onChange={(event) => setMode(event.target.value)}
            disabled={!configInfo?.editable}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="direct">{intl.get('直接访问')}</Radio.Button>
            <Radio.Button value="single">{intl.get('一层代理')}</Radio.Button>
            <Radio.Button value="hops">{intl.get('固定多层')}</Radio.Button>
            <Radio.Button value="custom">
              {intl.get('指定地址或网段')}
            </Radio.Button>
          </Radio.Group>

          <div style={{ marginTop: 12 }}>
            {mode === 'hops' && (
              <InputNumber
                min={2}
                max={20}
                value={hops}
                onChange={(value) => setHops(value || 2)}
                addonAfter={intl.get('层')}
                disabled={!configInfo?.editable}
              />
            )}
            {mode === 'custom' && (
              <Input
                style={{ maxWidth: 620 }}
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                disabled={!configInfo?.editable}
                placeholder="loopback,172.18.0.0/16,10.20.0.8/32"
              />
            )}
          </div>

          <Space style={{ marginTop: 12 }} wrap>
            <Button
              type="primary"
              onClick={save}
              loading={saving}
              disabled={!configInfo?.editable}
            >
              {intl.get('保存配置')}
            </Button>
            <Text type="secondary">
              {intl.get('当前生效值')}：
              <Text copyable>{configInfo?.trustProxy || '-'}</Text>
              {configInfo && `（${sourceMap[configInfo.source]}）`}
            </Text>
          </Space>
        </div>

        <div>
          <Space style={{ marginBottom: 12 }}>
            <Paragraph strong style={{ marginBottom: 0 }}>
              {intl.get('客户端 IP 诊断')}
            </Paragraph>
            <Button onClick={diagnose} loading={diagnosing}>
              {intl.get('重新诊断')}
            </Button>
          </Space>

          {diagnostic && (
            <>
              <Descriptions bordered size="small" column={1}>
                <Descriptions.Item label={intl.get('Socket 地址')}>
                  <Text copyable>{diagnostic.remoteAddress || '-'}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="X-Forwarded-For">
                  <Text copyable>
                    {diagnostic.forwardedFor.join(', ') || '-'}
                  </Text>
                </Descriptions.Item>
                <Descriptions.Item label={intl.get('最终客户端 IP')}>
                  <Text strong copyable>
                    {diagnostic.clientIp || '-'}
                  </Text>
                </Descriptions.Item>
              </Descriptions>

              <Table
                style={{ marginTop: 12 }}
                size="small"
                pagination={false}
                rowKey={(record) => `${record.hop}-${record.ip}`}
                dataSource={diagnostic.hops}
                columns={[
                  {
                    title: intl.get('距离青龙'),
                    dataIndex: 'hop',
                    width: 120,
                    render: (value) => `${value} ${intl.get('跳')}`,
                  },
                  { title: 'IP', dataIndex: 'ip' },
                  {
                    title: intl.get('判定'),
                    dataIndex: 'status',
                    width: 140,
                    render: (value: keyof typeof statusMap) => (
                      <Tag color={statusMap[value].color}>
                        {statusMap[value].text}
                      </Tag>
                    ),
                  },
                ]}
              />
            </>
          )}
        </div>
      </Space>
    </div>
  );
};

export default ClientIp;
