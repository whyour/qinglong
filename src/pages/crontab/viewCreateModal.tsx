import intl from 'react-intl-universal';
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
import { CrontabStatus } from './type';
import { useRequest } from 'ahooks';

const PROPERTIES = [
  { name: intl.get('命令'), value: 'command' },
  { name: intl.get('名称'), value: 'name' },
  { name: intl.get('定时规则'), value: 'schedule' },
  { name: intl.get('状态'), value: 'status', onlySelect: true },
  { name: intl.get('标签'), value: 'labels' },
  { name: intl.get('订阅'), value: 'sub_id', onlySelect: true },
];

const EOperation: any = {
  Reg: '',
  NotReg: '',
  In: 'select',
  Nin: 'select',
};
const OPERATIONS = [
  { name: intl.get('包含'), value: 'Reg' },
  { name: intl.get('不包含'), value: 'NotReg' },
  { name: intl.get('属于'), value: 'In', type: 'select' },
  { name: intl.get('不属于'), value: 'Nin', type: 'select' },
  // { name: '等于', value: 'Eq' },
  // { name: '不等于', value: 'Ne' },
  // { name: '为空', value: 'IsNull' },
  // { name: '不为空', value: 'NotNull' },
];

const SORTTYPES = [
  { name: intl.get('顺序'), value: 'ASC' },
  { name: intl.get('倒序'), value: 'DESC' },
];

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
  const filtersValue = Form.useWatch('filters', form);
  const { data } = useRequest(
    () => request.get(`${config.apiPrefix}subscriptions`),
    {
      cacheKey: 'subscriptions',
    },
  );

  const STATUS_MAP = {
    status: [
      { name: intl.get('运行中'), value: CrontabStatus.running },
      { name: intl.get('空闲中'), value: CrontabStatus.idle },
      { name: intl.get('已禁用'), value: CrontabStatus.disabled },
    ],
    sub_id: data?.data.map((x) => ({ name: x.name, value: x.id })),
  };

  const handleOk = async (values: any) => {
    setLoading(true);
    values.filterRelation = filterRelation;
    const method = view ? 'put' : 'post';
    try {
      const { code, data } = await request[method](
        `${config.apiPrefix}crons/views`,
        view ? { ...values, id: view.id } : values,
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
        filters: [{ property: 'command' }],
      },
    );
  }, [view, visible]);

  const OperationElement = ({ name, ...others }: { name: number }) => {
    const property = form.getFieldValue(['filters', name, 'property']);
    return (
      <Select
        style={{ width: 120 }}
        placeholder={intl.get('请选择操作符')}
        {...others}
      >
        {OPERATIONS.filter((x) =>
          STATUS_MAP[property as 'status' | 'sub_id'] ? x.type === 'select' : x,
        ).map((x) => (
          <Select.Option key={x.name} value={x.value}>
            {x.name}
          </Select.Option>
        ))}
      </Select>
    );
  };

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
    <Select style={{ width: 80 }}>
      {SORTTYPES.map((x) => (
        <Select.Option key={x.name} value={x.value}>
          {x.name}
        </Select.Option>
      ))}
    </Select>
  );

  const statusElement = (property: keyof typeof STATUS_MAP) => {
    return (
      <Select
        mode="tags"
        allowClear
        placeholder={intl.get('输入后回车增加自定义选项')}
      >
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
      title={view ? intl.get('编辑视图') : intl.get('创建视图')}
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
          label={intl.get('视图名称')}
          rules={[{ required: true, message: intl.get('请输入视图名称') }]}
        >
          <Input placeholder={intl.get('请输入视图名称')} />
        </Form.Item>
        <Form.List name="filters">
          {(fields, { add, remove }, { errors }) => (
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
                      padding: '0 3px',
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
                {fields.map(({ key, name, ...restField }) => (
                  <Form.Item
                    label={name === 0 ? intl.get('筛选条件') : ''}
                    key={key}
                    style={{ marginBottom: 0 }}
                    required
                    className="filter-item"
                  >
                    <Space
                      className="view-create-modal-filters"
                      align="baseline"
                    >
                      <Form.Item
                        {...restField}
                        name={[name, 'property']}
                        rules={[{ required: true }]}
                      >
                        {propertyElement(PROPERTIES, { width: 120 })}
                      </Form.Item>
                      <Form.Item
                        {...restField}
                        name={[name, 'operation']}
                        rules={[
                          { required: true, message: intl.get('请选择操作符') },
                        ]}
                      >
                        <OperationElement name={name} />
                      </Form.Item>
                      <Form.Item
                        {...restField}
                        name={[name, 'value']}
                        rules={[
                          { required: true, message: intl.get('请输入内容') },
                        ]}
                      >
                        {EOperation[filtersValue?.[name]['operation']] ===
                        'select' ? (
                          statusElement(filtersValue?.[name]['property'])
                        ) : (
                          <Input placeholder={intl.get('请输入内容')} />
                        )}
                      </Form.Item>
                      {name !== 0 && (
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
                    {intl.get('新增筛选条件')}
                  </a>
                </Form.Item>
                <Form.ErrorList errors={errors} />
              </div>
            </div>
          )}
        </Form.List>
        <Form.List name="sorts">
          {(fields, { add, remove }, { errors }) => (
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
                      padding: '0 3px',
                      cursor: 'pointer',
                    }}
                  >
                    <>
                      <span>{ViewFilterRelation[filterRelation]}</span>
                    </>
                  </Button>
                </div>
              )}
              <div>
                {fields.map(({ key, name, ...restField }) => (
                  <Form.Item
                    label={name === 0 ? intl.get('排序方式') : ''}
                    key={key}
                    style={{ marginBottom: 0 }}
                    className="filter-item"
                  >
                    <Space className="view-create-modal-sorts" align="baseline">
                      <Form.Item
                        {...restField}
                        name={[name, 'property']}
                        rules={[{ required: true }]}
                      >
                        {propertyElement(PROPERTIES)}
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
                    {intl.get('新增排序方式')}
                  </a>
                </Form.Item>
                <Form.ErrorList errors={errors} />
              </div>
            </div>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
};

export default ViewCreateModal;
