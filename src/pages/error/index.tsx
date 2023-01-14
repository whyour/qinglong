import React, { useState, useEffect } from 'react';
import config from '@/utils/config';
import { request } from '@/utils/http';
import Terminal, { ColorMode, LineType } from '../../components/terminal';
import { PageLoading } from '@ant-design/pro-layout';
import { history, useOutletContext } from '@umijs/max';
import Ansi from 'ansi-to-react';
import './index.less';
import { SharedContext } from '@/layouts';

const Error = () => {
  const { user, theme, reloadUser } = useOutletContext<SharedContext>();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState('暂无日志');

  const getTimes = () => {
    return parseInt(localStorage.getItem('error_retry_times') || '0', 10);
  };

  let times = getTimes();

  const getLog = (needLoading: boolean = true) => {
    needLoading && setLoading(true);
    request
      .get(`${config.apiPrefix}public/panel/log`)
      .then(({ code, data }) => {
        if (code === 200) {
          setData(data);
          if (!data) {
            times = getTimes();
            if (times > 5) {
              return;
            }
            localStorage.setItem('error_retry_times', `${times + 1}`);
            setTimeout(() => {
              reloadUser();
              getLog(false);
            }, 3000);
          }
        }
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
      ) : data ? (
        <Terminal
          name="服务错误"
          colorMode={theme === 'vs-dark' ? ColorMode.Dark : ColorMode.Light}
          lineData={[
            { type: LineType.Input, value: 'pm2 logs panel' },
            {
              type: LineType.Output,
              value: (
                <pre>
                  <Ansi>{data}</Ansi>
                </pre>
              ),
            },
          ]}
        />
      ) : times > 5 ? (
        <>服务启动超时，请手动进入容器执行 ql -l check 后刷新再试</>
      ) : (
        <PageLoading tip="启动中，请稍后..." />
      )}
    </div>
  );
};

export default Error;
