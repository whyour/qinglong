import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form, Select, Upload, Radio } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import { UploadOutlined } from '@ant-design/icons';

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
  const [file, setFile] = useState<File>();
  const [type, setType] = useState<'blank' | 'upload'>('blank');

  const handleOk = async (values: any) => {
    setLoading(true);
    values.path = values.path || '';
    const formData = new FormData();
    formData.append('file', file as any);
    formData.append('filename', values.filename);
    formData.append('path', values.path);
    formData.append('content', '');
    request
      .post(`${config.apiPrefix}scripts`, {
        data: formData,
      })
      .then(({ code, data }) => {
        if (code === 200) {
          message.success('保存文件成功');
          const key = values.path ? `${values.path}-` : '';
          const filename = file ? file.name : values.filename;
          handleCancel({
            filename,
            path: values.path,
            key: `${key}${filename}`,
          });
        } else {
          message.error(data);
        }
        setLoading(false);
      })
      .finally(() => setLoading(false));
  };

  const beforeUpload = (file: File) => {
    setFile(file);
    return false;
  };

  const typeChange = (e) => {
    setType(e.target.value);
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
          name="type"
          label="类型"
          rules={[{ required: true }]}
          initialValue={'blank'}
        >
          <Radio.Group onChange={typeChange}>
            <Radio value="blank">空文件</Radio>
            <Radio value="upload">本地上传</Radio>
          </Radio.Group>
        </Form.Item>
        {type === 'blank' && (
          <Form.Item
            name="filename"
            label="文件名"
            rules={[{ required: true, message: '请输入文件名' }]}
          >
            <Input placeholder="请输入文件名" />
          </Form.Item>
        )}
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
        {type === 'upload' && (
          <Form.Item label="文件" name="file">
            <Upload.Dragger beforeUpload={beforeUpload} maxCount={1}>
              <p className="ant-upload-drag-icon">
                <UploadOutlined />
              </p>
              <p className="ant-upload-text">点击或者拖拽文件到此区域上传</p>
            </Upload.Dragger>
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
};

export default EditScriptNameModal;
