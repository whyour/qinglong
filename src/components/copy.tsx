import React, { useRef, useState, useEffect } from 'react';
import { Tooltip, Typography } from 'antd';
import { CopyOutlined, CheckOutlined } from '@ant-design/icons';
import { CopyToClipboard } from 'react-copy-to-clipboard';

const { Link } = Typography;

const Copy = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  const copyIdRef = useRef<number>();

  const copyText = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();

    setCopied(true);

    cleanCopyId();
    copyIdRef.current = window.setTimeout(() => {
      setCopied(false);
    }, 3000);
  };

  const cleanCopyId = () => {
    window.clearTimeout(copyIdRef.current!);
  };

  return (
    <Link onClick={copyText} style={{ marginLeft: 1 }}>
      <CopyToClipboard text={text}>
        <Tooltip key="copy" title={copied ? '复制成功' : '复制'}>
          {copied ? <CheckOutlined /> : <CopyOutlined />}
        </Tooltip>
      </CopyToClipboard>
    </Link>
  );
};

export default Copy;
