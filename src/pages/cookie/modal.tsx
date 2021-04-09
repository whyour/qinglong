import React, { useEffect, useState } from 'react';
import { Modal, notification, Input, Form } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const CookieModal = ({
  cookie,
  handleCancel,
  visible,
}: {
  cookie?: any;
  visible: boolean;
  handleCancel: (needUpdate?: boolean) => void;
}) => {
  const [form] = Form.useForm();

  const handleOk = async (values: any) => {
    const cookies = values.value
      .split('\n')
      .map((x: any) => x.trim().replace(/\s/g, ''));
    let flag = false;
    for (const coo of cookies) {
      if (!/pt_key=\S*;\s*pt_pin=\S*;\s*/.test(coo)) {
        notification.error({ message: `${coo}格式有误` });
        flag = true;
        break;
      }
    }
    if (flag) {
      return;
    }
    const method = cookie ? 'put' : 'post';
    const payload = cookie ? { value: cookies[0], _id: cookie._id } : cookies;
    const { code, data } = await request[method](`${config.apiPrefix}cookies`, {
      data: payload,
    });
    if (code === 200) {
      notification.success({
        message: cookie ? '更新Cookie成功' : '添加Cookie成功',
      });
    } else {
      notification.error({
        message: data,
      });
    }
    handleCancel(true);
  };

  useEffect(() => {
    form.resetFields();
  }, [cookie]);

  return (
    <Modal
      title={cookie ? '编辑Cookie' : '新建Cookie'}
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
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        name="form_in_modal"
        preserve={false}
        initialValues={cookie}
      >
        <Form.Item
          name="value"
          rules={[
            { required: true, message: '请输入Cookie' },
            {
              pattern: /pt_key=\S*;\s*pt_pin=\S*;\s*/,
              message: 'Cookie格式错误，注意分号(pt_key=***;pt_pin=***;)',
            },
          ]}
        >
          <Input.TextArea
            rows={4}
            autoSize={true}
            placeholder="请输入cookie，多个cookie换行输入"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default CookieModal;
