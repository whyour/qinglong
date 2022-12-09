import React, { useEffect, useState } from 'react';
import {
  Modal,
  message,
  Input,
  Form,
  Statistic,
  Button,
  Space,
  Select,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import IconFont from '@/components/iconfont';
import get from 'lodash/get';

const PROPERTIES = [
  { name: '命令', value: 'command' },
  { name: '名称', value: 'name' },
  { name: '定时规则', value: 'schedule' },
  { name: '状态', value: 'status' },
  // { name: '标签', value: 'labels' },
];

const EOperation: any = {
  Reg: '',
  NotReg: '',
  In: 'select',
  Nin: 'select',
};
const OPERATIONS = [
  { name: '包含', value: 'Reg' },
  { name: '不包含', value: 'NotReg' },
  { name: '属于', value: 'In', type: 'select' },
  { name: '不属于', value: 'Nin', type: 'select' },
  // { name: '等于', value: 'Eq' },
  // { name: '不等于', value: 'Ne' },
  // { name: '为空', value: 'IsNull' },
  // { name: '不为空', value: 'NotNull' },
];

const SORTTYPES = [
  { name: '顺序', value: 'ASC' },
  { name: '倒序', value: 'DESC' },
];

const STATUS_MAP = {
  status: [
    { name: '运行中', value: 0 },
    { name: '空闲中', value: 1 },
    { name: '已禁用', value: 2 },
  ],
};

enum ViewFilterRelation {
  'and' = '且',
  'or' = '或',
}

const ViewCreateModal = ({
  view,
  handleCancel,
  visible,
}: {
  view?: any;
  visible: boolean;
  handleCancel: (param?: any) => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [filterRelation, setFilterRelation] = useState<'and' | 'or'>('and');

  const handleOk = async (values: any) => {
    setLoading(true);
    values.filterRelation = filterRelation;
    const method = view ? 'put' : 'post';
    try {
      const { code, data } = await request[method](
        `${config.apiPrefix}crons/views`,
        {
          data: view ? { ...values, id: view.id } : values,
        },
      );

      if (code === 200) {
        handleCancel(data);
      }
      setLoading(false);
    } catch (error: any) {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!view) {
      form.resetFields();
    }
    form.setFieldsValue(
      view || {
        filters: [{ property: 'command', operation: 'Reg' }],
      },
    );
  }, [view, visible]);

  const operationElement = (
    <Select style={{ width: 80 }}>
      {OPERATIONS.map((x) => (
        <Select.Option key={x.name} value={x.value}>
          {x.name}
        </Select.Option>
      ))}
    </Select>
  );

  const propertyElement = (props: any, style: React.CSSProperties = {}) => {
    return (
      <Select style={style}>
        {props.map((x) => (
          <Select.Option key={x.name} value={x.value}>
            {x.name}
          </Select.Option>
        ))}
      </Select>
    );
  };

  const typeElement = (
    <Select>
      {SORTTYPES.map((x) => (
        <Select.Option key={x.name} value={x.value}>
          {x.name}
        </Select.Option>
      ))}
    </Select>
  );

  const statusElement = (property: keyof typeof STATUS_MAP) => {
    return (
      <Select mode="tags" allowClear placeholder="输入后回车增加自定义选项">
        {STATUS_MAP[property]?.map((x) => (
          <Select.Option key={x.name} value={x.value}>
            {x.name}
          </Select.Option>
        ))}
      </Select>
    );
  };

  return (
    <Modal
      title={view ? '编辑视图' : '新建视图'}
      open={visible}
      forceRender
      width={580}
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
      <Form form={form} layout="vertical" name="env_modal">
        <Form.Item
          name="name"
          label="视图名称"
          rules={[{ required: true, message: '请输入视图名称' }]}
        >
          <Input placeholder="请输入视图名称" />
        </Form.Item>
        <Form.List name="filters">
          {(fields, { add, remove }) => (
            <div
              style={{ position: 'relative' }}
              className={`view-filters-container ${
                fields.length > 1 ? 'active' : ''
              }`}
            >
              {fields.length > 1 && (
                <div
                  style={{
                    position: 'absolute',
                    width: 50,
                    borderRadius: 10,
                    border: '1px solid rgb(190, 220, 255)',
                    borderRight: 'none',
                    height: 56 * (fields.length - 1),
                    top: 46,
                    left: 15,
                  }}
                >
                  <Button
                    type="primary"
                    size="small"
                    style={{
                      position: 'absolute',
                      top: '50%',
                      translate: '-50% -50%',
                      padding: '0 0 0 3px',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      setFilterRelation(
                        filterRelation === 'and' ? 'or' : 'and',
                      );
                    }}
                  >
                    <>
                      <span>{ViewFilterRelation[filterRelation]}</span>
                      <IconFont type="ql-icon-d-caret" />
                    </>
                  </Button>
                </div>
              )}
              <div>
                {fields.map(({ key, name, ...restField }, index) => (
                  <Form.Item
                    label={index === 0 ? '筛选条件' : ''}
                    key={key}
                    style={{ marginBottom: 0 }}
                    required
                    className="filter-item"
                  >
                    <Space
                      className="view-create-modal-filters"
                      align="baseline"
                      style={
                        fields.length > 1 ? { width: 'calc(100% - 40px)' } : {}
                      }
                    >
                      <Form.Item
                        {...restField}
                        name={[name, 'property']}
                        rules={[{ required: true }]}
                      >
                        {propertyElement(PROPERTIES, { width: 90 })}
                      </Form.Item>
                      <Form.Item
                        {...restField}
                        name={[name, 'operation']}
                        rules={[{ required: true }]}
                      >
                        {operationElement}
                      </Form.Item>
                      <Form.Item
                        noStyle
                        shouldUpdate={(prevValues, nextValues) => {
                          const preOperation =
                            EOperation[
                              get(prevValues, ['filters', name, 'operation'])
                            ];
                          const nextOperation =
                            EOperation[
                              get(nextValues, ['filters', name, 'operation'])
                            ];
                          const flag = preOperation !== nextOperation;
                          if (flag) {
                            form.setFieldValue(
                              ['filters', name, 'value'],
                              nextOperation === 'select' ? [] : '',
                            );
                          }
                          return flag;
                        }}
                      >
                        {() => {
                          const property = form.getFieldValue([
                            'filters',
                            index,
                            'property',
                          ]) as 'status';
                          const operate = form.getFieldValue([
                            'filters',
                            name,
                            'operation',
                          ]);
                          return (
                            <Form.Item
                              {...restField}
                              name={[name, 'value']}
                              rules={[
                                { required: true, message: '请输入内容' },
                              ]}
                            >
                              {EOperation[operate] === 'select' ? (
                                statusElement(property)
                              ) : (
                                <Input placeholder="请输入内容" />
                              )}
                            </Form.Item>
                          );
                        }}
                      </Form.Item>
                      {index !== 0 && (
                        <MinusCircleOutlined onClick={() => remove(name)} />
                      )}
                    </Space>
                  </Form.Item>
                ))}
                <Form.Item>
                  <a
                    onClick={() =>
                      add({ property: 'command', operation: 'Reg' })
                    }
                  >
                    <PlusOutlined />
                    新增筛选条件
                  </a>
                </Form.Item>
              </div>
            </div>
          )}
        </Form.List>
        <Form.List name="sorts">
          {(fields, { add, remove }) => (
            <>
              {fields.map(({ key, name, ...restField }, index) => (
                <Form.Item
                  label={index === 0 ? '排序方式' : ''}
                  key={key}
                  style={{ marginBottom: 0 }}
                >
                  <Space className="view-create-modal-sorts" align="baseline">
                    <Form.Item
                      {...restField}
                      name={[name, 'property']}
                      rules={[{ required: true }]}
                    >
                      {propertyElement(PROPERTIES, { width: 240 })}
                    </Form.Item>
                    <Form.Item
                      {...restField}
                      name={[name, 'type']}
                      rules={[{ required: true }]}
                    >
                      {typeElement}
                    </Form.Item>
                    <MinusCircleOutlined onClick={() => remove(name)} />
                  </Space>
                </Form.Item>
              ))}
              <Form.Item>
                <a onClick={() => add({ property: 'command', type: 'ASC' })}>
                  <PlusOutlined />
                  新增排序方式
                </a>
              </Form.Item>
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
};

export default ViewCreateModal;
