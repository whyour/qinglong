import intl from 'react-intl-universal';
import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  message,
  Input,
  Form,
  Statistic,
  Button,
  Typography,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import {
  Loading3QuartersOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import { PageLoading } from '@ant-design/pro-layout';
import { logEnded } from '@/utils';
import { CrontabStatus } from './type';
import Ansi from 'ansi-to-react';

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
  const uniqPath = logUrl ? logUrl : String(cron?.id);

  const getCronLog = (isFirst?: boolean) => {
    if (isFirst) {
      setLoading(true);
    }
    request
      .get(logUrl ? logUrl : `${config.apiPrefix}crons/${cron.id}/log`)
      .then(({ code, data }) => {
        if (
          code === 200 &&
          localStorage.getItem('logCron') === uniqPath &&
          data !== value
        ) {
          const log = data as string;
          setValue(log || intl.get('暂无日志'));
          const hasNext = Boolean(
            log && !logEnded(log) && !log.includes('任务未运行'),
          );
          if (!hasNext && !logEnded(value) && value !== intl.get('启动中...')) {
            setTimeout(() => {
              autoScroll();
            });
          }
          setExecuting(hasNext);
          if (hasNext) {
            setTimeout(() => {
              autoScroll();
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

  const handleScroll: React.UIEventHandler<HTMLDivElement> = (e) => {
    const sTop = (e.target as HTMLDivElement).scrollTop;
    if (scrollInfoRef.current.down) {
      scrollInfoRef.current = {
        value: sTop,
        down: sTop - scrollInfoRef.current.value > -5 || !sTop,
      };
    }
  };

  const titleElement = () => {
    return (
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {(executing || loading) && <Loading3QuartersOutlined spin />}
        {!executing && !loading && <CheckCircleOutlined />}
        <Typography.Text ellipsis={true} style={{ marginLeft: 5 }}>
          {cron && cron.name}
        </Typography.Text>
      </div>
    );
  };

  useEffect(() => {
    if (cron && cron.id && visible) {
      getCronLog(true);
      scrollInfoRef.current.down = true;
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
            <Ansi>{value}</Ansi>
          </pre>
        )}
        <div id="log-flag"></div>
      </div>
    </Modal>
  );
};

export default CronLogModal;
