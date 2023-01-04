import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const RenameModal = ({
  currentNode,
  handleCancel,
  visible,
}: {
  currentNode?: any;
  visible: boolean;
  handleCancel: () => void;
}) => {
  console.log(currentNode);
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleOk = async (values: any) => {
    setLoading(true);
    try {
      const { code, data } = await request.put(
        `${config.apiPrefix}scripts/rename`,
        {
          data: {
            filename: currentNode.title,
            path: currentNode.parent || '',
            newFilename: values.name,
          },
        },
      );

      if (code === 200) {
        message.success('更新名称成功');
        handleCancel();
      }
      setLoading(false);
    } catch (error) {
      setLoading(false);
    }
  };

  useEffect(() => {
    form.resetFields();
  }, [currentNode, visible]);

  return (
    <Modal
      title="重命名"
      open={visible}
      forceRender
      centered
      maskClosable={false}
      onOk={() => {
        form
          .validateFields()
          .then((values) => {
            handleOk(values);
          })
          .catch((info) => {
            console.log('Validate Failed:', info);
          });
      }}
      onCancel={() => handleCancel()}
      confirmLoading={loading}
    >
      <Form form={form} layout="vertical" name="edit_name_modal">
        <Form.Item
          name="name"
          rules={[{ required: true, message: '请输入新名称' }]}
        >
          <Input placeholder="请输入新名称" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default RenameModal;
