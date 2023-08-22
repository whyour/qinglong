import intl from 'react-intl-universal';
import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form, Radio, Select } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const { Option } = Select;
enum DependenceTypes {
  'nodejs',
  'python3',
  'linux',
}

const DependenceModal = ({
  dependence,
  handleCancel,
  visible,
  defaultType,
}: {
  dependence?: any;
  visible: boolean;
  handleCancel: (cks?: any[]) => void;
  defaultType: string;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleOk = async (values: any) => {
    setLoading(true);
    const { name, split, type, remark } = values;
    const method = dependence ? 'put' : 'post';
    let payload;
    if (!dependence) {
      if (split === '1') {
        const symbol = name.includes('&') ? '&' : '\n';
        payload = name.split(symbol).map((x: any) => {
          return {
            name: x,
            type,
            remark,
          };
        });
      } else {
        payload = [{ name, type, remark }];
      }
    } else {
      payload = { ...values, id: dependence.id };
    }
    try {
      const { code, data } = await request[method](
        `${config.apiPrefix}dependencies`,
        payload,
      );

      if (code === 200) {
        handleCancel(data);
      }
      setLoading(false);
    } catch (error) {
      setLoading(false);
    }
  };

  useEffect(() => {
    form.resetFields();
  }, [dependence, visible]);

  return (
    <Modal
      title={dependence ? intl.get('编辑依赖') : intl.get('创建依赖')}
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
        name="dependence_modal"
        initialValues={dependence}
      >
        <Form.Item
          name="type"
          label={intl.get('依赖类型')}
          initialValue={DependenceTypes[defaultType as any]}
        >
          <Select>
            {config.dependenceTypes.map((x, i) => (
              <Option key={i} value={i}>
                {x}
              </Option>
            ))}
          </Select>
        </Form.Item>
        {!dependence && (
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
          name="name"
          label={intl.get('名称')}
          rules={[
            {
              required: true,
              message: intl.get('请输入依赖名称，支持指定版本'),
              whitespace: true,
            },
          ]}
        >
          <Input.TextArea
            rows={4}
            autoSize={{ minRows: 1, maxRows: 5 }}
            placeholder={intl.get('请输入依赖名称')}
          />
        </Form.Item>
        <Form.Item name="remark" label={intl.get('备注')}>
          <Input placeholder={intl.get('请输入备注')} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default DependenceModal;
