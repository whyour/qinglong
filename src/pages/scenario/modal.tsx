import React, { useState, useEffect } from 'react';
import {
  Modal,
  Form,
  Input,
  Select,
  InputNumber,
  Switch,
  Button,
  Space,
  Card,
  message,
  Divider,
} from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { request } from '@/utils/http';
import intl from 'react-intl-universal';

const { TextArea } = Input;
const { Option } = Select;

interface ScenarioModalProps {
  visible: boolean;
  scenario: any;
  onCancel: () => void;
  onSuccess: () => void;
}

const ScenarioModal: React.FC<ScenarioModalProps> = ({
  visible,
  scenario,
  onCancel,
  onSuccess,
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [triggerType, setTriggerType] = useState('time');

  useEffect(() => {
    if (visible) {
      if (scenario) {
        form.setFieldsValue({
          ...scenario,
          conditions: scenario.conditions || [],
          actions: scenario.actions || [],
        });
        setTriggerType(scenario.triggerType);
      } else {
        form.resetFields();
        form.setFieldsValue({
          isEnabled: 1,
          conditionLogic: 'AND',
          failureThreshold: 3,
          delayExecution: 0,
          conditions: [],
          actions: [],
        });
        setTriggerType('time');
      }
    }
  }, [visible, scenario, form]);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);

      const endpoint = scenario ? '/api/scenarios' : '/api/scenarios';
      const method = scenario ? 'put' : 'post';
      const payload = scenario ? { ...values, id: scenario.id } : values;

      const { code } = await request[method](endpoint, payload);
      if (code === 200) {
        message.success(
          scenario ? intl.get('更新成功') : intl.get('创建成功'),
        );
        onSuccess();
      }
    } catch (error) {
      console.error('Failed to save scenario:', error);
    } finally {
      setLoading(false);
    }
  };

  const renderTriggerConfig = () => {
    switch (triggerType) {
      case 'variable':
        return (
          <Form.Item
            name={['triggerConfig', 'watchPath']}
            label={intl.get('监听路径')}
            rules={[{ required: true }]}
          >
            <Input placeholder="/path/to/watch" />
          </Form.Item>
        );
      case 'webhook':
        return (
          <Form.Item name={['triggerConfig', 'token']} label="Token">
            <Input
              placeholder={intl.get('留空自动生成')}
              disabled={!!scenario}
            />
          </Form.Item>
        );
      case 'time':
        return (
          <Form.Item
            name={['triggerConfig', 'schedule']}
            label={intl.get('Cron 表达式')}
            rules={[{ required: true }]}
          >
            <Input placeholder="0 0 * * *" />
          </Form.Item>
        );
      case 'system_event':
        return (
          <>
            <Form.Item
              name={['triggerConfig', 'eventType']}
              label={intl.get('事件类型')}
              rules={[{ required: true }]}
            >
              <Select>
                <Option value="disk_space">{intl.get('磁盘空间')}</Option>
                <Option value="memory">{intl.get('内存使用')}</Option>
              </Select>
            </Form.Item>
            <Form.Item
              name={['triggerConfig', 'threshold']}
              label={intl.get('阈值')} 
              rules={[{ required: true }]}
            >
              <InputNumber min={0} max={100} addonAfter="%" />
            </Form.Item>
            <Form.Item
              name={['triggerConfig', 'checkInterval']}
              label={intl.get('检查间隔')}
            >
              <InputNumber min={10000} addonAfter="ms" />
            </Form.Item>
          </>
        );
      case 'task_status':
        return (
          <Form.Item
            name={['triggerConfig', 'cronId']}
            label={intl.get('任务 ID')}
            rules={[{ required: true }]}
          >
            <InputNumber min={1} />
          </Form.Item>
        );
      default:
        return null;
    }
  };

  return (
    <Modal
      title={scenario ? intl.get('编辑场景') : intl.get('新建场景')}
      open={visible}
      onCancel={onCancel}
      onOk={handleSubmit}
      confirmLoading={loading}
      width={800}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label={intl.get('名称')}
          rules={[{ required: true }]}
        >
          <Input />
        </Form.Item>

        <Form.Item name="description" label={intl.get('描述')}>
          <TextArea rows={2} />
        </Form.Item>

        <Form.Item
          name="triggerType"
          label={intl.get('触发类型')}
          rules={[{ required: true }]}
        >
          <Select onChange={setTriggerType}>
            <Option value="time">{intl.get('时间触发')}</Option>
            <Option value="variable">{intl.get('变量监听')}</Option>
            <Option value="webhook">Webhook</Option>
            <Option value="task_status">{intl.get('任务状态')}</Option>
            <Option value="system_event">{intl.get('系统事件')}</Option>
          </Select>
        </Form.Item>

        {renderTriggerConfig()}

        <Divider orientation="left">{intl.get('条件配置')}</Divider>

        <Form.Item
          name="conditionLogic"
          label={intl.get('条件逻辑')}
          tooltip={intl.get('多个条件之间的关系')}
        >
          <Select>
            <Option value="AND">AND ({intl.get('全部满足')})</Option>
            <Option value="OR">OR ({intl.get('任一满足')})</Option>
          </Select>
        </Form.Item>

        <Form.List name="conditions">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field) => (
                <Card
                  key={field.key}
                  size="small"
                  style={{ marginBottom: 8 }}
                  extra={
                    <DeleteOutlined
                      onClick={() => remove(field.name)}
                      style={{ color: 'red' }}
                    />
                  }
                >
                  <Space>
                    <Form.Item
                      {...field}
                      name={[field.name, 'field']}
                      noStyle
                      rules={[{ required: true }]}
                    >
                      <Input
                        placeholder={intl.get('字段名')}
                        style={{ width: 150 }}
                      />
                    </Form.Item>
                    <Form.Item
                      {...field}
                      name={[field.name, 'operator']}
                      noStyle
                      rules={[{ required: true }]}
                    >
                      <Select placeholder={intl.get('操作符')} style={{ width: 120 }}>
                        <Option value="equals">=</Option>
                        <Option value="not_equals">!=</Option>
                        <Option value="greater_than">&gt;</Option>
                        <Option value="less_than">&lt;</Option>
                        <Option value="contains">{intl.get('包含')}</Option>
                        <Option value="not_contains">{intl.get('不包含')}</Option>
                      </Select>
                    </Form.Item>
                    <Form.Item
                      {...field}
                      name={[field.name, 'value']}
                      noStyle
                      rules={[{ required: true }]}
                    >
                      <Input
                        placeholder={intl.get('值')}
                        style={{ width: 150 }}
                      />
                    </Form.Item>
                  </Space>
                </Card>
              ))}
              <Button
                type="dashed"
                onClick={() => add()}
                block
                icon={<PlusOutlined />}
              >
                {intl.get('添加条件')}
              </Button>
            </>
          )}
        </Form.List>

        <Divider orientation="left">{intl.get('动作配置')}</Divider>

        <Form.List name="actions">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field) => (
                <Card
                  key={field.key}
                  size="small"
                  style={{ marginBottom: 8 }}
                  extra={
                    <DeleteOutlined
                      onClick={() => remove(field.name)}
                      style={{ color: 'red' }}
                    />
                  }
                >
                  <Form.Item
                    {...field}
                    name={[field.name, 'type']}
                    label={intl.get('动作类型')}
                    rules={[{ required: true }]}
                  >
                    <Select>
                      <Option value="run_task">{intl.get('运行任务')}</Option>
                      <Option value="set_variable">{intl.get('设置变量')}</Option>
                      <Option value="execute_command">{intl.get('执行命令')}</Option>
                      <Option value="send_notification">{intl.get('发送通知')}</Option>
                    </Select>
                  </Form.Item>
                  <Form.Item
                    noStyle
                    shouldUpdate={(prevValues, currentValues) =>
                      prevValues.actions?.[field.name]?.type !==
                      currentValues.actions?.[field.name]?.type
                    }
                  >
                    {({ getFieldValue }) => {
                      const actionType = getFieldValue([
                        'actions',
                        field.name,
                        'type',
                      ]);
                      if (actionType === 'run_task') {
                        return (
                          <Form.Item
                            {...field}
                            name={[field.name, 'cronId']}
                            label={intl.get('任务 ID')}
                            rules={[{ required: true }]}
                          >
                            <InputNumber min={1} style={{ width: '100%' }} />
                          </Form.Item>
                        );
                      }
                      if (actionType === 'set_variable') {
                        return (
                          <>
                            <Form.Item
                              {...field}
                              name={[field.name, 'name']}
                              label={intl.get('变量名')}
                              rules={[{ required: true }]}
                            >
                              <Input />
                            </Form.Item>
                            <Form.Item
                              {...field}
                              name={[field.name, 'value']}
                              label={intl.get('变量值')}
                              rules={[{ required: true }]}
                            >
                              <Input />
                            </Form.Item>
                          </>
                        );
                      }
                      if (actionType === 'execute_command') {
                        return (
                          <Form.Item
                            {...field}
                            name={[field.name, 'command']}
                            label={intl.get('命令')}
                            rules={[{ required: true }]}
                          >
                            <TextArea rows={2} />
                          </Form.Item>
                        );
                      }
                      if (actionType === 'send_notification') {
                        return (
                          <Form.Item
                            {...field}
                            name={[field.name, 'message']}
                            label={intl.get('消息')}
                            rules={[{ required: true }]}
                          >
                            <TextArea rows={2} />
                          </Form.Item>
                        );
                      }
                      return null;
                    }}
                  </Form.Item>
                </Card>
              ))}
              <Button
                type="dashed"
                onClick={() => add()}
                block
                icon={<PlusOutlined />}
              >
                {intl.get('添加动作')}
              </Button>
            </>
          )}
        </Form.List>

        <Divider orientation="left">{intl.get('高级设置')}</Divider>

        <Form.Item name="delayExecution" label={intl.get('延迟执行')}>
          <InputNumber min={0} addonAfter={intl.get('秒')} />
        </Form.Item>

        <Form.Item
          name="failureThreshold"
          label={intl.get('失败熔断阈值')}
          tooltip={intl.get('连续失败多少次后自动禁用')}
        >
          <InputNumber min={1} />
        </Form.Item>

        <Form.Item name={['retryStrategy', 'maxRetries']} label={intl.get('最大重试次数')}>
          <InputNumber min={0} max={10} />
        </Form.Item>

        <Form.Item
          name={['retryStrategy', 'retryDelay']}
          label={intl.get('重试延迟')}
        >
          <InputNumber min={1} addonAfter={intl.get('秒')} />
        </Form.Item>

        <Form.Item
          name={['retryStrategy', 'backoffMultiplier']}
          label={intl.get('退避倍数')}
          tooltip={intl.get('每次重试延迟的乘数')}
        >
          <InputNumber min={1} step={0.5} />
        </Form.Item>

        <Form.Item
          name="isEnabled"
          label={intl.get('启用')}
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default ScenarioModal;
