import { GifOutlined } from '@ant-design/icons';
import { Tooltip, Button } from 'antd';

export const MinimapSwitch = (props: {
  minimapVisible: boolean;
  setMinimapVisible: (visible: boolean) => void;
}) => {
  const { minimapVisible, setMinimapVisible } = props;

  return (
    <Tooltip title="Minimap">
      <Button
        icon={
          <GifOutlined
            style={{
              color: minimapVisible ? undefined : '#060709cc',
            }}
          />
        }
        onClick={() => {
          setMinimapVisible(Boolean(!minimapVisible));
        }}
      />
    </Tooltip>
  );
};
