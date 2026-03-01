import { FlowNodeEntity } from '@flowgram.ai/fixed-layout-editor';
import { Typography } from 'antd';

interface PropsType {
  node: FlowNodeEntity;
}

const Text = Typography.Text;

export function AgentLabel(props: PropsType) {
  const { node } = props;

  let label = 'Default';

  switch (node.flowNodeType) {
    case 'agentMemory':
      label = 'Memory';
      break;
    case 'agentLLM':
      label = 'LLM';
      break;
    case 'agentTools':
      label = 'Tools';
  }

  return (
    <Text
      ellipsis={{ tooltip: true }}
      style={{
        maxWidth: 65,
        fontSize: 12,
        textAlign: 'center',
        padding: '2px',
        backgroundColor: 'var(--g-editor-background)',
        color: '#8F959E',
      }}
    >
      {label}
    </Text>
  );
}
