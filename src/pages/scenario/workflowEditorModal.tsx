import React, { useRef, useState, useEffect } from 'react';
import { Modal, message } from 'antd';
import intl from 'react-intl-universal';
import { WorkflowGraph } from './type';
import FlowgramEditor, { FlowgramEditorRef } from './flowgram/FlowgramEditor';
import './workflowEditor.less';

interface WorkflowEditorModalProps {
  visible: boolean;
  workflowGraph?: WorkflowGraph;
  onOk: (graph: WorkflowGraph) => void;
  onCancel: () => void;
}

const WorkflowEditorModal: React.FC<WorkflowEditorModalProps> = ({
  visible,
  workflowGraph,
  onOk,
  onCancel,
}) => {
  const editorRef = useRef<FlowgramEditorRef>(null);
  const [editorData, setEditorData] = useState<any>(null);

  useEffect(() => {
    if (visible && workflowGraph) {
      // Convert our WorkflowGraph format to Flowgram format
      const flowgramData = {
        nodes: workflowGraph.nodes?.map((node) => ({
          id: node.id,
          type: node.type,
          data: {
            title: node.label,
            ...node.config,
          },
          position: {
            x: node.x || 0,
            y: node.y || 0,
          },
        })) || [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      };
      setEditorData(flowgramData);
    } else if (visible) {
      setEditorData({
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      });
    }
  }, [visible, workflowGraph]);

  const handleOk = () => {
    if (!editorRef.current) {
      message.warning(intl.get('工作流至少需要一个节点'));
      return;
    }

    const data = editorRef.current.getData();
    
    // Convert Flowgram format back to our WorkflowGraph format
    const workflowGraph: WorkflowGraph = {
      nodes: data.nodes?.map((node: any) => ({
        id: node.id,
        type: node.type,
        label: node.data?.title || '',
        x: node.position?.x,
        y: node.position?.y,
        config: {
          ...node.data,
        },
      })) || [],
      startNode: data.nodes?.[0]?.id,
    };

    if (workflowGraph.nodes.length === 0) {
      message.warning(intl.get('工作流至少需要一个节点'));
      return;
    }

    onOk(workflowGraph);
    message.success(intl.get('工作流验证通过'));
  };

  const handleChange = (data: any) => {
    setEditorData(data);
  };

  return (
    <Modal
      title={intl.get('工作流编辑器')}
      open={visible}
      onOk={handleOk}
      onCancel={onCancel}
      width="95vw"
      style={{ top: 20 }}
      bodyStyle={{ height: '85vh', padding: 0 }}
      okText={intl.get('保存工作流')}
      cancelText={intl.get('取消')}
      destroyOnClose
    >
      {visible && editorData && (
        <FlowgramEditor
          ref={editorRef}
          initialData={editorData}
          onChange={handleChange}
        />
      )}
    </Modal>
  );
};

export default WorkflowEditorModal;
