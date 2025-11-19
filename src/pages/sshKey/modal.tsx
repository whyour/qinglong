import intl from 'react-intl-universal';
import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const SshKeyModal = ({
  sshKey,
  handleCancel,
}: {
  sshKey?: any;
  handleCancel: (keys?: any[]) => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleOk = async (values: any) => {
    setLoading(true);
    const method = sshKey ? 'put' : 'post';
    const payload = sshKey ? { ...values, id: sshKey.id } : [values];
    try {
      const { code, data } = await request[method](
        `${config.apiPrefix}sshKeys`,
        payload,
      );

      if (code === 200) {
        message.success(
          sshKey ? intl.get('更新SSH密钥成功') : intl.get('创建SSH密钥成功'),
        );
        handleCancel(data);
      }
      setLoading(false);
    } catch (error: any) {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={sshKey ? intl.get('编辑SSH密钥') : intl.get('创建SSH密钥')}
      open={true}
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
      <Form form={form} layout="vertical" name="ssh_key_modal" initialValues={sshKey}>
        <Form.Item
          name="alias"
          label={intl.get('别名')}
          rules={[
            {
              required: true,
              message: intl.get('请输入SSH密钥别名'),
              whitespace: true,
            },
          ]}
        >
          <Input placeholder={intl.get('请输入SSH密钥别名')} disabled={!!sshKey} />
        </Form.Item>
        <Form.Item
          name="private_key"
          label={intl.get('私钥')}
          rules={[
            {
              required: true,
              message: intl.get('请输入SSH私钥'),
              whitespace: true,
            },
          ]}
        >
          <Input.TextArea
            autoSize={{ minRows: 4, maxRows: 12 }}
            placeholder={intl.get('请输入SSH私钥内容（以 -----BEGIN 开头）')}
          />
        </Form.Item>
        <Form.Item name="remarks" label={intl.get('备注')}>
          <Input placeholder={intl.get('请输入备注')} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default SshKeyModal;
