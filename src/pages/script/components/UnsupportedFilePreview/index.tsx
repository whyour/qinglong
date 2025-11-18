import React from 'react';
import { Button, Space } from 'antd';
import { FileUnknownOutlined, WarningOutlined } from '@ant-design/icons';
import intl from 'react-intl-universal';
import styles from './index.module.less';

interface UnsupportedFilePreviewProps {
  onForceOpen: () => void;
}

const UnsupportedFilePreview: React.FC<UnsupportedFilePreviewProps> = ({
  onForceOpen,
}) => {
  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <div className={styles.iconWrapper}>
          <FileUnknownOutlined className={styles.icon} />
        </div>
        <div className={styles.message}>
          {intl.get('当前文件不支持预览')}
        </div>
        <Space direction="vertical" size={8} className={styles.actionArea}>
          <Button 
            type="primary" 
            onClick={onForceOpen}
            className={styles.button}
          >
            {intl.get('强制打开')}
          </Button>
          <div className={styles.warning}>
            <WarningOutlined className={styles.warningIcon} />
            {intl.get('强制打开可能会导致编辑器显示异常')}
          </div>
        </Space>
      </div>
    </div>
  );
};

export default UnsupportedFilePreview; 