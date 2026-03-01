import { ExpandOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';

export const FitView = (props: { fitView: () => void }) => (
  <Tooltip title="FitView">
    <Button
      icon={<ExpandOutlined />}
      onClick={() => props.fitView()}
    />
  </Tooltip>
);
