import intl from 'react-intl-universal';
import React, { useEffect, useRef, useState } from 'react';
import { Modal, message, Input, Form, Statistic, Button } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import {
  Loading3QuartersOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import { PageLoading } from '@ant-design/pro-layout';
import { logEnded } from '@/utils';
import { CrontabStatus } from './type';

const { Countdown } = Statistic;

const CronLogModal = ({
  cron,
  handleCancel,
  visible,
  data,
  logUrl,
}: {
  cron?: any;
  visible: boolean;
  handleCancel: () => void;
  data?: string;
  logUrl?: string;
}) => {
  const [value, setValue] = useState<string>(intl.get('启动中...'));
  const [loading, setLoading] = useState<any>(true);
  const [executing, setExecuting] = useState<any>(true);
  const [isPhone, setIsPhone] = useState(false);
  const scrollInfoRef = useRef({ value: 0, down: true });

  const getCronLog = (isFirst?: boolean) => {
    if (isFirst) {
      setLoading(true);
    }
    request
      .get(logUrl ? logUrl : `${config.apiPrefix}crons/${cron.id}/log`)
      .then(({ code, data }) => {
        if (
          code === 200 &&
          localStorage.getItem('logCron') === String(cron.id) &&
          data !== value
        ) {
          const log = data as string;
          setValue(log || intl.get('暂无日志'));
          const hasNext = Boolean(
            log && !logEnded(log) && !log.includes('任务未运行'),
          );
          setExecuting(hasNext);
          if (hasNext) {
            autoScroll();
            setTimeout(() => {
              getCronLog();
            }, 2000);
          }
        }
      })
      .finally(() => {
        if (isFirst) {
          setLoading(false);
        }
      });
  };

  const autoScroll = () => {
    if (!scrollInfoRef.current.down) {
      return;
    }

    setTimeout(() => {
      document
        .querySelector('#log-flag')!
        .scrollIntoView({ behavior: 'smooth' });
    }, 600);
  };

  const cancel = () => {
    localStorage.removeItem('logCron');
    handleCancel();
  };

  const handleScroll = (e) => {
    const sTop = e.target.scrollTop;
    if (scrollInfoRef.current.down) {
      scrollInfoRef.current = {
        value: sTop,
        down: sTop > scrollInfoRef.current.value,
      };
    }
  };

  const titleElement = () => {
    return (
      <>
        {(executing || loading) && <Loading3QuartersOutlined spin />}
        {!executing && !loading && <CheckCircleOutlined />}
        <span style={{ marginLeft: 5 }}>{cron && cron.name}</span>
      </>
    );
  };

  useEffect(() => {
    if (cron && cron.id && visible) {
      getCronLog(true);
    }
  }, [cron, visible]);

  useEffect(() => {
    if (data) {
      setValue(data);
    }
  }, [data]);

  useEffect(() => {
    setIsPhone(document.body.clientWidth < 768);
  }, []);

  return (
    <Modal
      title={titleElement()}
      open={visible}
      centered
      className="log-modal"
      forceRender
      onOk={() => cancel()}
      onCancel={() => cancel()}
      footer={[
        <Button type="primary" onClick={() => cancel()}>
          {intl.get('知道了')}
        </Button>,
      ]}
    >
      <div onScroll={handleScroll} className="log-container">
        {loading ? (
          <PageLoading />
        ) : (
          <pre
            style={
              isPhone
                ? {
                    fontFamily: 'Source Code Pro',
                    zoom: 0.83,
                  }
                : {}
            }
          >
            {value}
          </pre>
        )}
        <div id="log-flag"></div>
      </div>
    </Modal>
  );
};

export default CronLogModal;
