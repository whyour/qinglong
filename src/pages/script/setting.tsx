import intl from 'react-intl-universal';
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
      .post(`${config.apiPrefix}scripts`, payload)
      .then(({ code, data }) => {
        if (code === 200) {
          message.success(intl.get('保存文件成功'));
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
      title={intl.get('运行设置')}
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
          label={intl.get('待开发')}
          rules={[{ required: true, message: intl.get('待开发') }]}
        >
          <Input placeholder={intl.get('待开发')} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default SettingModal;
