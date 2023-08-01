import intl from 'react-intl-universal';
import React from 'react';
import { Button, Result, Typography } from 'antd';

const { Link } = Typography;

const NotFound: React.FC = () => (
  <Result
    status="404"
    title="404"
    extra={
      <Button type="primary">
        <Link href="/">{intl.get('返回首页')}</Link>
      </Button>
    }
  />
);

export default NotFound;
