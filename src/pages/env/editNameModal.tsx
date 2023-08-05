import intl from 'react-intl-universal'
import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const EditNameModal = ({
  ids,
  handleCancel,
  visible,
}: {
  ids?: string[];
  visible: boolean;
  handleCancel: () => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleOk = async (values: any) => {
    setLoading(true);
    try {
      const { code, data } = await request.put(`${config.apiPrefix}envs/name`, {
        ids,
        name: values.name,
      });

      if (code === 200) {
        message.success(intl.get('更新环境变量名称成功'));
        handleCancel();
      }
      setLoading(false);
    } catch (error) {
      setLoading(false);
    }
  };

  useEffect(() => {
    form.resetFields();
  }, [ids, visible]);

  return (
    <Modal
      title={intl.get('修改环境变量名称')}
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
          rules={[{ required: true, message: intl.get('请输入新的环境变量名称') }]}
        >
          <Input placeholder={intl.get('请输入新的环境变量名称')} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default EditNameModal;
