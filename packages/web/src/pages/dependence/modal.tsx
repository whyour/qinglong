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
        {
          data: payload,
        },
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
      title={dependence ? '编辑依赖' : '新建依赖'}
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
          label="依赖类型"
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
            label="自动拆分"
            initialValue="0"
            tooltip="多个依赖是否换行分割"
          >
            <Radio.Group>
              <Radio value="1">是</Radio>
              <Radio value="0">否</Radio>
            </Radio.Group>
          </Form.Item>
        )}
        <Form.Item
          name="name"
          label="名称"
          rules={[
            { required: true, message: '请输入依赖名称', whitespace: true },
          ]}
        >
          <Input.TextArea
            rows={4}
            autoSize={true}
            placeholder="请输入依赖名称"
          />
        </Form.Item>
        <Form.Item name="remark" label="备注">
          <Input placeholder="请输入备注" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default DependenceModal;
