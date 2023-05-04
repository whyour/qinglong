import React, { useState, useEffect, useRef } from 'react';
import config from '@/utils/config';
import { request } from '@/utils/http';
import { PageLoading } from '@ant-design/pro-layout';
import { history, useOutletContext } from '@umijs/max';
import './index.less';
import { SharedContext } from '@/layouts';
import { Alert, Typography } from 'antd';

const Error = () => {
  const { user, theme, reloadUser } = useOutletContext<SharedContext>();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState('暂无日志');
  const retryTimes = useRef(1);

  const getLog = (needLoading: boolean = true) => {
    needLoading && setLoading(true);
    request
      .get(`${config.apiPrefix}public/health`)
      .then(({ status, error }) => {
        if (status === 1) {
          return reloadUser();
        }
        if (retryTimes.current > 3) {
          setData(error?.details);
          return;
        }
        retryTimes.current += 1;
        setTimeout(() => {
          reloadUser();
          getLog(false);
        }, 3000);
      })
      .finally(() => needLoading && setLoading(false));
  };

  useEffect(() => {
    if (user && user.username) {
      history.push('/crontab');
    }
  }, [user]);

  useEffect(() => {
    getLog();
  }, []);

  return (
    <div className="error-wrapper">
      {loading ? (
        <PageLoading />
      ) : retryTimes.current > 3 ? (
        <div className="code-box">
          <div className="browser-markup"></div>
          <Alert
            type="error"
            message="服务启动超时，请检查如下日志或者进入容器执行 ql -l check 后刷新再试"
            banner
          />
          <Typography.Paragraph className="log">{data}</Typography.Paragraph>
        </div>
      ) : (
        <PageLoading tip="启动中，请稍后..." />
      )}
    </div>
  );
};

export default Error;
