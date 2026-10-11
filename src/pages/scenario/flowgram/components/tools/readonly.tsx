import { useCallback } from 'react';

import { usePlayground } from '@flowgram.ai/fixed-layout-editor';
import { Button } from 'antd';
import { UnlockOutlined, LockOutlined } from '@ant-design/icons';

export const Readonly = () => {
  const playground = usePlayground();
  const toggleReadonly = useCallback(() => {
    playground.config.readonly = !playground.config.readonly;
  }, [playground]);

  return playground.config.readonly ? (
    <Button icon={<LockOutlined />} onClick={toggleReadonly} />
  ) : (
    <Button icon={<UnlockOutlined />} onClick={toggleReadonly} />
  );
};
