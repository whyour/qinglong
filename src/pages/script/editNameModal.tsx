import React, { useEffect, useState } from 'react';
import {
  Modal,
  message,
  Input,
  Form,
  Select,
  Upload,
  Radio,
  TreeSelect,
} from 'antd';
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
  const [type, setType] = useState<'blank' | 'upload' | 'directory'>('blank');

  const handleOk = async (values: any) => {
    setLoading(true);
    const { path = '', filename: inputFilename, directory = '' } = values;
    const formData = new FormData();
    formData.append('file', file as any);
    formData.append('filename', inputFilename);
    formData.append('path', path);
    formData.append('content', '');
    formData.append('directory', directory);
    request
      .post(`${config.apiPrefix}scripts`, {
        data: formData,
      })
      .then(({ code, data }) => {
        if (code === 200) {
          message.success(directory ? '新建文件夹成功' : '新建文件成功');
          const key = path ? `${path}/` : '';
          const filename = file ? file.name : inputFilename;
          handleCancel({
            filename,
            path,
            key: `${key}${filename}`,
          });
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

  const getDirs = (data) => {
    for (const item of data) {
      if (item.children && item.children.length > 0) {
        item.children = item.children
          .filter((x) => x.type === 'directory')
          .map((x) => ({ ...x, disabled: false }));
        getDirs(item.children);
      }
    }
    return data;
  };

  useEffect(() => {
    const originDirs = treeData
      .filter((x) => x.type === 'directory')
      .map((x) => ({ ...x, disabled: false }));
    const dirs = getDirs(originDirs);
    setDirs(dirs);
  }, [treeData]);

  useEffect(() => {
    form.resetFields();
  }, [visible]);

  return (
    <Modal
      title="新建"
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
          name="type"
          label="类型"
          rules={[{ required: true }]}
          initialValue={'blank'}
        >
          <Radio.Group onChange={typeChange}>
            <Radio value="blank">空文件</Radio>
            <Radio value="upload">本地文件</Radio>
            <Radio value="directory">文件夹</Radio>
          </Radio.Group>
        </Form.Item>
        {type === 'blank' && (
          <Form.Item
            name="filename"
            label="文件名"
            rules={[
              { required: true, message: '请输入文件名' },
              {
                validator: (_, value) =>
                  value.includes('/')
                    ? Promise.reject(new Error('文件名不能包含斜杠'))
                    : Promise.resolve(),
              },
            ]}
          >
            <Input placeholder="请输入文件名" />
          </Form.Item>
        )}
        {type === 'directory' && (
          <Form.Item
            name="directory"
            label="文件夹名"
            rules={[{ required: true, message: '请输入文件夹名' }]}
          >
            <Input placeholder="请输入文件夹名" />
          </Form.Item>
        )}
        <Form.Item label="父目录" name="path">
          <TreeSelect
            allowClear
            treeData={dirs}
            fieldNames={{ value: 'key', label: 'title' }}
            placeholder="请选择父目录"
            treeDefaultExpandAll
          />
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
