import React, { useCallback } from 'react';

import { DisplaySchemaTag } from '@flowgram.ai/form-materials';
import { Typography, Tooltip } from 'antd';

import './index.css';

const { Text } = Typography;

interface FormItemProps {
  children: React.ReactNode;
  name: string;
  type: string;
  required?: boolean;
  description?: string;
  labelWidth?: number;
  vertical?: boolean;
}
export function FormItem({
  children,
  name,
  required,
  description,
  type,
  labelWidth,
  vertical,
}: FormItemProps): JSX.Element {
  const renderTitle = useCallback(
    (showTooltip?: boolean) => (
      <div style={{ width: '0', display: 'flex', flex: '1' }}>
        <Text style={{ width: '100%' }} ellipsis={{ tooltip: !!showTooltip }}>
          {name}
        </Text>
        {required && <span style={{ color: '#f93920', paddingLeft: '2px' }}>*</span>}
      </div>
    ),
    []
  );
  return (
    <div
      style={{
        fontSize: 12,
        marginBottom: 6,
        width: '100%',
        position: 'relative',
        display: 'flex',
        gap: 8,
        ...(vertical
          ? { flexDirection: 'column' }
          : {
              justifyContent: 'center',
              alignItems: 'center',
            }),
      }}
    >
      <div
        style={{
          justifyContent: 'center',
          alignItems: 'center',
          color: 'var(--semi-color-text-0)',
          width: labelWidth || 118,
          position: 'relative',
          display: 'flex',
          columnGap: 4,
          flexShrink: 0,
        }}
      >
        <DisplaySchemaTag value={{ type }} />
        {description ? <Tooltip title={description}>{renderTitle()}</Tooltip> : renderTitle(true)}
      </div>

      <div
        style={{
          flexGrow: 1,
          minWidth: 0,
        }}
      >
        {children}
      </div>
    </div>
  );
}
