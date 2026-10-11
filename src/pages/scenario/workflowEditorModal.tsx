import React, { useRef, useState } from 'react';
import { Modal, message } from 'antd';
import intl from 'react-intl-universal';
import { WorkflowGraph } from './type';
import { Editor, EditorHandle } from './flowgram/editor';
import './workflowEditor.less';

interface WorkflowEditorModalProps {
  visible: boolean;
  workflowGraph?: WorkflowGraph;
  onOk: (graph: WorkflowGraph) => Promise<void> | void;
  onCancel: () => void;
}

const WorkflowEditorModal: React.FC<WorkflowEditorModalProps> = ({
  visible,
  workflowGraph,
  onOk,
  onCancel,
}) => {
  const editor = useRef<EditorHandle>(null);
  const [saving, setSaving] = useState(false);
  const handleOk = async () => {
    setSaving(true);
    try {
      const graph = await editor.current?.snapshot();
      if (!graph?.nodes?.length) {
        message.warning(intl.get('请检查工作流节点配置'));
        return;
      }
      await onOk(graph);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={intl.get('工作流编辑器')}
      open={visible}
      onOk={handleOk}
      onCancel={onCancel}
      confirmLoading={saving}
      width="95vw"
      style={{ top: 20 }}
      bodyStyle={{ height: '85vh', padding: 0 }}
      okText={intl.get('保存工作流')}
      cancelText={intl.get('取消')}
      destroyOnClose
    >
      {visible && <Editor ref={editor} initialData={workflowGraph} />}
    </Modal>
  );
};
export default WorkflowEditorModal;
