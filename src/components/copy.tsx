import intl from 'react-intl-universal';
import React, { useRef, useState, useEffect } from 'react';
import { Tooltip, Typography, message } from 'antd';
import { CopyOutlined, CheckOutlined } from '@ant-design/icons';
import { CopyToClipboard } from 'react-copy-to-clipboard';

const { Link } = Typography;

const Copy = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  const copyIdRef = useRef<number>();

  const handleCopy = (text: string, result: boolean) => {
    if (result) {
      setCopied(true);
      message.success(intl.get('复制成功'));

      cleanCopyId();
      copyIdRef.current = window.setTimeout(() => {
        setCopied(false);
      }, 3000);
    }
  };

  const handleClick = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
  };

  const cleanCopyId = () => {
    window.clearTimeout(copyIdRef.current!);
  };

  return (
    <Link onClick={handleClick} style={{ marginLeft: 4 }}>
      <CopyToClipboard text={text} onCopy={handleCopy}>
        <Tooltip
          key="copy"
          title={copied ? intl.get('复制成功') : intl.get('复制')}
        >
          {copied ? <CheckOutlined /> : <CopyOutlined />}
        </Tooltip>
      </CopyToClipboard>
    </Link>
  );
};

export default Copy;
