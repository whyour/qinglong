import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const CookieModal = ({
  cookie,
  handleCancel,
  visible,
}: {
  cookie?: any;
  visible: boolean;
  handleCancel: (cks?: any[]) => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleOk = async (values: any) => {
    const cookies = values.value
      .split('\n')
      .map((x: any) => x.trim().replace(/\s/g, ''));
    let flag = false;
    for (const coo of cookies) {
      if (!/pt_key=\S*;\s*pt_pin=\S*;\s*/.test(coo)) {
        message.error(`${coo}格式有误`);
        flag = true;
        break;
      }
    }
    if (flag) {
      return;
    }
    setLoading(true);
    const method = cookie ? 'put' : 'post';
    const payload = cookie ? { value: cookies[0], _id: cookie._id } : cookies;
    const { code, data } = await request[method](`${config.apiPrefix}cookies`, {
      data: payload,
    });
    if (code === 200) {
      message.success(cookie ? '更新Cookie成功' : '添加Cookie成功');
    } else {
      message.error(data);
    }
    setLoading(false);
    handleCancel(cookie ? [data] : data);
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
      confirmLoading={loading}
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
            placeholder="请输入cookie，可直接换行输入多个cookie"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default CookieModal;
