import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form, Select } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const { Option } = Select;

const EditScriptNameModal = ({
  handleCancel,
  treeData,
  visible,
}: {
  visible: boolean;
  treeData: any[];
  handleCancel: (file?: {
    filename: string;
    path: string;
    key: string;
  }) => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [dirs, setDirs] = useState<any[]>([]);

  const handleOk = async (values: any) => {
    setLoading(true);
    values.path = values.path || '';
    request
      .post(`${config.apiPrefix}scripts`, {
        data: { filename: values.filename, path: values.path, content: '' },
      })
      .then(({ code, data }) => {
        if (code === 200) {
          message.success('保存文件成功');
          handleCancel({
            filename: values.filename,
            path: values.path,
            key: `${values.path}-${values.filename}`,
          });
        } else {
          message.error(data);
        }
        setLoading(false);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    form.resetFields();
    const originDirs = treeData.filter((x) => x.disabled);
    setDirs([{ key: '' }, ...originDirs]);
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
          label="文件名"
          rules={[{ required: true, message: '请输入文件名' }]}
        >
          <Input placeholder="请输入文件名" />
        </Form.Item>
        <Form.Item
          label="父目录"
          name="path"
          initialValue={dirs && dirs.length > 0 ? dirs[0].key : ''}
        >
          <Select placeholder="请选择父目录">
            {dirs.map((x) => (
              <Option value={x.key}>{x.key || '根'}</Option>
            ))}
          </Select>
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default EditScriptNameModal;
