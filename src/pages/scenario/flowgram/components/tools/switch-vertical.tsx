import { CloudServerOutlined } from '@ant-design/icons';
import { usePlaygroundTools } from '@flowgram.ai/fixed-layout-editor';
import { Button, Tooltip } from 'antd';

export const SwitchVertical = () => {
  const tools = usePlaygroundTools();
  return (
    <Tooltip title={!tools.isVertical ? 'Vertical Layout' : 'Horizontal Layout'}>
      <Button
        size="small"
        onClick={() => tools.changeLayout()}
        icon={
          <CloudServerOutlined
            style={{
              transform: !tools.isVertical ? '' : 'rotate(90deg)',
              transition: 'transform .3s ease',
            }}
          />
        }
      />
    </Tooltip>
  );
};
