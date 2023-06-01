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
      .then(({ error, data }) => {
        if (data?.status === 1) {
          return;
        }
        if (retryTimes.current > 3) {
          setData(error?.details);
          return;
        }
        retryTimes.current += 1;
        setTimeout(() => {
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
            message={
              <Typography.Title level={5} type="danger">
                服务启动超时
              </Typography.Title>
            }
            description={
              <Typography.Text type="danger">
                <div>请先按如下方式修复：</div>
                <div>
                  1. 宿主机执行 docker run --rm -v
                  /var/run/docker.sock:/var/run/docker.sock
                  containrrr/watchtower -cR &lt;容器名&gt;
                </div>
                <div>2. 容器内执行 ql -l check、ql -l update</div>
                <div>
                  3. 如果无法解决，容器内执行 pm2 logs，拷贝执行结果
                  <Typography.Link href="https://github.com/whyour/qinglong/issues/new?assignees=&labels=&template=bug_report.yml">
                    提交 issue
                  </Typography.Link>
                </div>
              </Typography.Text>
            }
            banner
          />
          <Typography.Paragraph code className="log">
            {data}
          </Typography.Paragraph>
        </div>
      ) : (
        <PageLoading style={{ paddingTop: 0 }} tip="启动中，请稍后..." />
      )}
    </div>
  );
};

export default Error;
