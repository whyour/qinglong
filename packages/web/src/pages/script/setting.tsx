import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const SettingModal = ({
  file,
  handleCancel,
  visible,
}: {
  file?: any;
  visible: boolean;
  handleCancel: (cks?: any[]) => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleOk = async (values: any) => {
    setLoading(true);
    const payload = { ...file, ...values };
    request
      .post(`${config.apiPrefix}scripts`, {
        data: payload,
      })
      .then(({ code, data }) => {
        if (code === 200) {
          message.success('保存文件成功');
          handleCancel(data);
        }
        setLoading(false);
      });
  };

  useEffect(() => {
    form.resetFields();
    setLoading(false);
  }, [file, visible]);

  return (
    <Modal
      title="运行设置"
      open={visible}
      forceRender
      centered
      onCancel={() => handleCancel()}
    >
      <Form
        form={form}
        layout="vertical"
        name="setting_modal"
        initialValues={file}
      >
        <Form.Item
          name="filename"
          label="待开发"
          rules={[{ required: true, message: '待开发' }]}
        >
          <Input placeholder="待开发" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default SettingModal;
