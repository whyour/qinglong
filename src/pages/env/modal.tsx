import intl from 'react-intl-universal';
import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form, Radio } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const EnvModal = ({
  env,
  handleCancel,
  visible,
}: {
  env?: any;
  visible: boolean;
  handleCancel: (cks?: any[]) => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleOk = async (values: any) => {
    setLoading(true);
    const { value, split, name, remarks } = values;
    const method = env ? 'put' : 'post';
    let payload;
    if (!env) {
      if (split === '1') {
        const symbol = value.includes('&') ? '&' : '\n';
        payload = value.split(symbol).map((x: any) => {
          return {
            name: name,
            value: x,
            remarks: remarks,
          };
        });
      } else {
        payload = [{ value, name, remarks }];
      }
    } else {
      payload = { ...values, id: env.id };
    }
    try {
      const { code, data } = await request[method](
        `${config.apiPrefix}envs`,
        payload,
      );

      if (code === 200) {
        message.success(
          env ? intl.get('更新变量成功') : intl.get('创建变量成功'),
        );
        handleCancel(data);
      }
      setLoading(false);
    } catch (error: any) {
      setLoading(false);
    }
  };

  useEffect(() => {
    form.resetFields();
  }, [env, visible]);

  return (
    <Modal
      title={env ? intl.get('编辑变量') : intl.get('创建变量')}
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
      <Form form={form} layout="vertical" name="env_modal" initialValues={env}>
        <Form.Item
          name="name"
          label={intl.get('名称')}
          rules={[
            {
              required: true,
              message: intl.get('请输入环境变量名称'),
              whitespace: true,
            },
            {
              pattern: /^[a-zA-Z_][0-9a-zA-Z_]*$/,
              message: intl.get('只能输入字母数字下划线，且不能以数字开头'),
            },
          ]}
        >
          <Input placeholder={intl.get('请输入环境变量名称')} />
        </Form.Item>
        {!env && (
          <Form.Item
            name="split"
            label={intl.get('自动拆分')}
            initialValue="0"
            tooltip={intl.get('多个依赖是否换行分割')}
          >
            <Radio.Group>
              <Radio value="1">{intl.get('是')}</Radio>
              <Radio value="0">{intl.get('否')}</Radio>
            </Radio.Group>
          </Form.Item>
        )}
        <Form.Item
          name="value"
          label={intl.get('值')}
          rules={[
            {
              required: true,
              message: intl.get('请输入环境变量值'),
              whitespace: true,
            },
          ]}
        >
          <Input.TextArea
            autoSize={{ minRows: 1, maxRows: 8 }}
            placeholder={intl.get('请输入环境变量值')}
          />
        </Form.Item>
        <Form.Item name="remarks" label={intl.get('备注')}>
          <Input placeholder={intl.get('请输入备注')} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default EnvModal;
