import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const SaveModal = ({
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
    const payload = { ...file, ...values, originFilename: file.filename };
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
      title="保存文件"
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
      <Form
        form={form}
        layout="vertical"
        name="script_modal"
        initialValues={file}
      >
        <Form.Item
          name="filename"
          label="文件名"
          rules={[{ required: true, message: '请输入文件名' }]}
        >
          <Input placeholder="请输入文件名" />
        </Form.Item>
        <Form.Item name="path" label="保存目录">
          <Input placeholder="请输入保存目录，默认scripts目录" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default SaveModal;
