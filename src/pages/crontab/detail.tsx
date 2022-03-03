import React, { useEffect, useState } from 'react';
import {
  Modal,
  message,
  Input,
  Form,
  Button,
  Card,
  Tag,
  Popover,
  Divider,
} from 'antd';
import {
  ClockCircleOutlined,
  CloseCircleOutlined,
  FieldTimeOutlined,
  Loading3QuartersOutlined,
} from '@ant-design/icons';
import { CrontabStatus } from './index';
import { diffTime } from '@/utils/date';

const contentList: any = {
  log: <p>log content</p>,
  script: <p>script content</p>,
};

const tabList = [
  {
    key: 'log',
    tab: '日志',
  },
  {
    key: 'script',
    tab: '脚本',
  },
];

const language = navigator.language || navigator.languages[0];

const CronDetailModal = ({
  cron = {},
  handleCancel,
  visible,
}: {
  cron?: any;
  visible: boolean;
  handleCancel: (needUpdate?: boolean) => void;
}) => {
  const [activeTabKey, setActiveTabKey] = useState('log');

  const onTabChange = (key: string) => {
    setActiveTabKey(key);
  };

  return (
    <Modal
      title={
        <>
          <span>{cron.name}</span>
          <Divider type="vertical"></Divider>
          {cron.labels?.length > 0 &&
            cron.labels[0] !== '' &&
            cron.labels?.map((label: string, i: number) => (
              <Tag color="blue" style={{ marginRight: 5 }}>
                {label}
              </Tag>
            ))}
        </>
      }
      centered
      visible={visible}
      forceRender
      footer={false}
      onCancel={() => handleCancel()}
      width={'80vw'}
      bodyStyle={{ background: '#eee', padding: 12 }}
    >
      <div style={{ height: '70vh', overflowY: 'auto' }}>
        <Card bodyStyle={{ display: 'flex', justifyContent: 'space-between' }}>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">状态</div>
            <div className="cron-detail-info-value">
              {(!cron.isDisabled || cron.status !== CrontabStatus.idle) && (
                <>
                  {cron.status === CrontabStatus.idle && (
                    <Tag icon={<ClockCircleOutlined />} color="default">
                      空闲中
                    </Tag>
                  )}
                  {cron.status === CrontabStatus.running && (
                    <Tag
                      icon={<Loading3QuartersOutlined spin />}
                      color="processing"
                    >
                      运行中
                    </Tag>
                  )}
                  {cron.status === CrontabStatus.queued && (
                    <Tag icon={<FieldTimeOutlined />} color="default">
                      队列中
                    </Tag>
                  )}
                </>
              )}
              {cron.isDisabled === 1 && cron.status === CrontabStatus.idle && (
                <Tag icon={<CloseCircleOutlined />} color="error">
                  已禁用
                </Tag>
              )}
            </div>
          </div>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">任务</div>
            <div className="cron-detail-info-value">{cron.command}</div>
          </div>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">定时</div>
            <div className="cron-detail-info-value">{cron.schedule}</div>
          </div>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">最后运行时间</div>
            <div className="cron-detail-info-value">
              {cron.last_execution_time
                ? new Date(cron.last_execution_time * 1000)
                    .toLocaleString(language, {
                      hour12: false,
                    })
                    .replace(' 24:', ' 00:')
                : '-'}
            </div>
          </div>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">最后运行时长</div>
            <div className="cron-detail-info-value">
              {cron.last_running_time ? diffTime(cron.last_running_time) : '-'}
            </div>
          </div>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">下次运行时间</div>
            <div className="cron-detail-info-value">
              {cron.nextRunTime &&
                cron.nextRunTime
                  .toLocaleString(language, {
                    hour12: false,
                  })
                  .replace(' 24:', ' 00:')}
            </div>
          </div>
        </Card>
        <Card
          style={{ marginTop: 16 }}
          tabList={tabList}
          activeTabKey={activeTabKey}
          onTabChange={(key) => {
            onTabChange(key);
          }}
        >
          {contentList[activeTabKey]}
        </Card>
      </div>
    </Modal>
  );
};

export default CronDetailModal;
