import React, { useCallback, useImperativeHandle, useState } from 'react';
import { Modal, Input, Form } from 'antd';

const addFilterModal = React.forwardRef((props: any, ref) => {
  const [form] = Form.useForm();
  const [visible, setVisible] = useState(false);

  useImperativeHandle(ref, () => ({
    showModal: () => {
      form.resetFields();
      setVisible(true);
    },
  }));

  const handleCancel = useCallback(() => {
    form.resetFields();
    setVisible(false);
  }, [form, setVisible]);

  const handleOk = useCallback(async () => {
    form.validateFields().then((values) => {
      setVisible(false);
      props.handleOk(values);
    });
  }, [setVisible, props.handleOk]);

  return (
    <Modal
      title={'新建筛选'}
      visible={visible}
      forceRender
      onOk={handleOk}
      onCancel={handleCancel}
      destroyOnClose
    >
      <Form form={form} layout="vertical" name="form_in_modal" preserve={false}>
        <Form.Item name="title" label="名称" rules={[{ required: true }]}>
          <Input placeholder="请输入筛选Tab名称" />
        </Form.Item>
        <Form.Item name="key" label="关键词" rules={[{ required: true }]}>
          <Input placeholder="请输入名称或者关键词" />
        </Form.Item>
      </Form>
    </Modal>
  );
});

export default addFilterModal;
