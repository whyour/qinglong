import intl from 'react-intl-universal';
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
    const payload = { ...file, ...values, originFilename: file.title };
    request
      .post(`${config.apiPrefix}scripts`, payload)
      .then(({ code, data }) => {
        if (code === 200) {
          message.success(intl.get('保存文件成功'));
          handleCancel(data);
        }
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    form.resetFields();
    setLoading(false);
  }, [file, visible]);

  return (
    <Modal
      title={intl.get('保存文件')}
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
        initialValues={{ filename: file?.title, path: file?.parent || '' }}
      >
        <Form.Item
          name="filename"
          label={intl.get('文件名')}
          rules={[{ required: true, message: intl.get('请输入文件名') }]}
        >
          <Input placeholder={intl.get('请输入文件名')} />
        </Form.Item>
        <Form.Item name="path" label={intl.get('保存目录')}>
          <Input placeholder={intl.get('请输入保存目录，默认scripts目录')} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default SaveModal;
