import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const EditScriptNameModal = ({
  handleCancel,
  visible,
}: {
  visible: boolean;
  handleCancel: (file?: { filename: string }) => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleOk = async (values: any) => {
    setLoading(true);
    request
      .post(`${config.apiPrefix}scripts`, {
        data: { filename: values.filename, content: '' },
      })
      .then(({ code, data }) => {
        if (code === 200) {
          message.success('保存文件成功');
          handleCancel({ filename: values.filename });
        } else {
          message.error(data);
        }
        setLoading(false);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    form.resetFields();
  }, [visible]);

  return (
    <Modal
      title="新建文件"
      visible={visible}
      forceRender
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
          name="filename"
          rules={[{ required: true, message: '请输入文件名' }]}
        >
          <Input placeholder="请输入文件名" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default EditScriptNameModal;
