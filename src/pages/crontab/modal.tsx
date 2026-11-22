import EditableTagGroup from '@/components/tag';
import config from '@/utils/config';
import { request } from '@/utils/http';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  message,
} from 'antd';
import { useEffect, useState } from 'react';
import intl from 'react-intl-universal';
import { getScheduleType, scheduleTypeMap } from './const';
import { ScheduleType } from './type';

const CronModal = ({
  cron,
  handleCancel,
}: {
  cron?: any;
  handleCancel: (needUpdate?: boolean) => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [scheduleType, setScheduleType] = useState<ScheduleType>(
    cron ? getScheduleType(cron.schedule) : ScheduleType.Normal,
  );

  const handleOk = async (values: any) => {
    setLoading(true);
    try {
      const method = cron?.id ? 'put' : 'post';
      const payload = {
        ...values,
        labels: values.labels || [],
        schedule:
          scheduleType !== ScheduleType.Normal
            ? scheduleTypeMap[scheduleType]
            : values.schedule,
      };

      if (cron?.id) {
        payload.id = cron.id;
      }

      const { code, data } = await request[method](
        `${config.apiPrefix}crons`,
        payload,
      );

      if (code === 200) {
        message.success(
          cron?.id ? intl.get('更新任务成功') : intl.get('创建任务成功'),
        );
        handleCancel(data);
      }
    } catch (error: any) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handleScheduleTypeChange = (type: ScheduleType) => {
    setScheduleType(type);
    form.setFieldValue('schedule', '');
  };

  const renderScheduleOptions = () => (
    <Select
      defaultValue={scheduleType}
      value={scheduleType}
      onChange={handleScheduleTypeChange}
    >
      <Select.Option value={ScheduleType.Normal}>
        {intl.get('常规定时')}
      </Select.Option>
      <Select.Option value={ScheduleType.Once}>
        {intl.get('手动运行')}
      </Select.Option>
      <Select.Option value={ScheduleType.Boot}>
        {intl.get('开机运行')}
      </Select.Option>
    </Select>
  );

  const [preview, setPreview] = useState('');
  const previewRule = async (_: unknown, rule?: string) => {
    if (!rule?.trim()) return;
    let result;
    let invalid = false;
    try {
      result = await request.get(`${config.apiPrefix}crons/preview`, {
        params: { schedule: rule },
        onError: (response) => {
          invalid = response?.status === 400;
        },
      });
    } catch {
      /* Transport errors have no validation result. */
    }
    if (!result?.data?.times)
      throw new Error(
        intl.get(invalid ? 'Cron表达式格式有误' : '无法获取调度预览，请重试'),
      );
    if (form.getFieldValue('schedule') === rule) {
      const { times, timezone } = result.data;
      setPreview(
        times
          .map((time: number) =>
            new Date(time).toLocaleString(undefined, { timeZone: timezone }),
          )
          .join(' · ') +
          ' (' +
          timezone +
          ')',
      );
    }
  };

  const renderScheduleFields = () => {
    if (scheduleType !== ScheduleType.Normal) return null;

    return (
      <>
        <Form.Item
          name="schedule"
          label={intl.get('定时规则')}
          extra={preview || undefined}
          validateTrigger="onBlur"
          rules={[{ required: true }, { validator: previewRule }]}
        >
          <Input
            onChange={() => setPreview('')}
            placeholder={intl.get('秒(可选) 分 时 天 月 周')}
          />
        </Form.Item>
        <Form.Item name="skip_if_pending" valuePropName="checked">
          <Checkbox>
            {intl.get('如果上一次定时执行仍在排队或运行，跳过本次')}
          </Checkbox>
        </Form.Item>
        <Form.Item
          name="max_queue_wait"
          label={intl.get('最长排队时间（秒）')}
          extra={intl.get('超时后跳过本次执行。填 0 表示不限时。')}
        >
          <InputNumber min={0} max={86400} precision={0} placeholder="0" />
        </Form.Item>
        <Form.Item
          name="catchup_seconds"
          label={intl.get('重启后往前查找的时长（秒）')}
          extra={intl.get(
            '每条规则只补跑这段时间内最近一次错过的执行。填 0 关闭补跑。',
          )}
        >
          <InputNumber min={0} max={86400} precision={0} placeholder="0" />
        </Form.Item>
        <Form.List name="extra_schedules">
          {(fields, { add, remove }, { errors }) => (
            <>
              {fields.map(({ key, name, ...restField }) => (
                <Form.Item key={key} noStyle>
                  <Space className="view-create-modal-sorts" align="baseline">
                    <Form.Item
                      {...restField}
                      name={[name, 'schedule']}
                      validateTrigger="onBlur"
                      rules={[{ required: true }, { validator: previewRule }]}
                    >
                      <Input
                        placeholder={intl.get('秒(可选) 分 时 天 月 周')}
                      />
                    </Form.Item>
                    <MinusCircleOutlined
                      className="dynamic-delete-button"
                      onClick={() => remove(name)}
                    />
                  </Space>
                </Form.Item>
              ))}
              <Form.Item>
                <a onClick={() => add({ schedule: '' })}>
                  <PlusOutlined /> {intl.get('新增定时规则')}
                </a>
              </Form.Item>
              <Form.ErrorList errors={errors} />
            </>
          )}
        </Form.List>
      </>
    );
  };

  return (
    <Modal
      title={cron?.id ? intl.get('编辑任务') : intl.get('创建任务')}
      open={true}
      forceRender
      centered
      maskClosable={false}
      onOk={() => form.validateFields().then(handleOk)}
      onCancel={() => handleCancel()}
      confirmLoading={loading}
    >
      <Form
        form={form}
        layout="vertical"
        name="form_in_modal"
        initialValues={cron}
      >
        <Form.Item
          name="name"
          label={intl.get('名称')}
          rules={[{ required: true, whitespace: true }]}
        >
          <Input placeholder={intl.get('请输入任务名称')} />
        </Form.Item>
        <Form.Item
          name="command"
          label={intl.get('命令/脚本')}
          rules={[{ required: true, whitespace: true }]}
        >
          <Input.TextArea
            rows={4}
            autoSize={{ minRows: 1, maxRows: 5 }}
            placeholder={intl.get(
              '支持输入脚本路径/任意系统可执行命令/task 脚本路径',
            )}
          />
        </Form.Item>
        <Form.Item label={intl.get('定时类型')} required>
          {renderScheduleOptions()}
        </Form.Item>
        {renderScheduleFields()}
        <Form.Item name="labels" label={intl.get('标签')}>
          <EditableTagGroup />
        </Form.Item>
        <Form.Item
          name="allow_multiple_instances"
          label={intl.get('实例模式')}
          tooltip={intl.get(
            '单实例模式下，已有实例运行时会跳过新触发。多实例模式允许同时运行多个实例。',
          )}
        >
          <Select placeholder={intl.get('请选择实例模式')}>
            <Select.Option value={0}>{intl.get('单实例')}</Select.Option>
            <Select.Option value={1}>{intl.get('多实例')}</Select.Option>
          </Select>
        </Form.Item>
        <Form.Item
          name="log_name"
          label={intl.get('日志名称')}
          tooltip={intl.get(
            '自定义日志文件夹名称，用于区分不同任务的日志，留空则自动生成。支持 /dev/null 丢弃日志，其他绝对路径必须在日志目录内',
          )}
          rules={[
            {
              validator: (_, value) => {
                if (!value) return Promise.resolve();
                if (value === '/dev/null') return Promise.resolve();
                if (value.length > 100) {
                  return Promise.reject(intl.get('日志名称不能超过100个字符'));
                }
                if (
                  !/^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?:\/)?(?:[\w\p{Script=Han}.-]+\/)*[\w\p{Script=Han}.-]+\/?$/u.test(
                    value,
                  )
                ) {
                  return Promise.reject(
                    intl.get(
                      '日志名称只能包含中文、字母、数字、下划线、连字符、点和路径分隔符',
                    ),
                  );
                }
                return Promise.resolve();
              },
            },
          ]}
        >
          <Input
            placeholder={intl.get('请输入自定义日志文件夹名称或 /dev/null')}
            maxLength={200}
          />
        </Form.Item>
        <Form.Item
          name="work_dir"
          label={intl.get('工作目录')}
          tooltip={intl.get(
            '脚本执行时的工作目录，留空则自动检测。相对路径基于 scripts 目录，也支持绝对路径',
          )}
        >
          <Input placeholder={intl.get('留空自动检测，或输入相对/绝对路径')} />
        </Form.Item>
        <Form.Item
          name="task_before"
          label={intl.get('执行前')}
          tooltip={intl.get(
            '运行任务前执行的命令，比如 cp/mv/python3 xxx.py/node xxx.js',
          )}
          rules={[
            {
              validator(_, value) {
                if (
                  value &&
                  (value.includes(' task ') || value.startsWith('task '))
                ) {
                  return Promise.reject(intl.get('不能包含 task 命令'));
                }
                return Promise.resolve();
              },
            },
          ]}
        >
          <Input.TextArea
            rows={4}
            autoSize={{ minRows: 1, maxRows: 5 }}
            placeholder={intl.get(
              '请输入运行任务前要执行的命令，不能包含 task 命令',
            )}
          />
        </Form.Item>
        <Form.Item
          name="task_after"
          label={intl.get('执行后')}
          tooltip={intl.get(
            '运行任务后执行的命令，比如 cp/mv/python3 xxx.py/node xxx.js',
          )}
          rules={[
            {
              validator(_, value) {
                if (
                  value &&
                  (value.includes(' task ') || value.startsWith('task '))
                ) {
                  return Promise.reject(intl.get('不能包含 task 命令'));
                }
                return Promise.resolve();
              },
            },
          ]}
        >
          <Input.TextArea
            rows={4}
            autoSize={{ minRows: 1, maxRows: 5 }}
            placeholder={intl.get(
              '请输入运行任务后要执行的命令，不能包含 task 命令',
            )}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};

const CronLabelModal = ({
  ids,
  handleCancel,
}: {
  ids: Array<string>;
  handleCancel: (needUpdate?: boolean) => void;
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const update = async (action: 'delete' | 'post') => {
    form
      .validateFields()
      .then(async (values) => {
        setLoading(true);
        const payload = { ids, labels: values.labels };
        try {
          const { code, data } = await request[action](
            `${config.apiPrefix}crons/labels`,
            payload,
          );

          if (code === 200) {
            message.success(
              action === 'post'
                ? intl.get('添加Labels成功')
                : intl.get('删除Labels成功'),
            );
            handleCancel(true);
          }
          setLoading(false);
        } catch (error) {
          setLoading(false);
        }
      })
      .catch((info) => {
        console.log('Validate Failed:', info);
      });
  };

  const buttons = [
    <Button onClick={() => handleCancel(false)}>{intl.get('取消')}</Button>,
    <Button type="primary" danger onClick={() => update('delete')}>
      {intl.get('删除')}
    </Button>,
    <Button type="primary" onClick={() => update('post')}>
      {intl.get('添加')}
    </Button>,
  ];

  return (
    <Modal
      title={intl.get('批量修改标签')}
      open={true}
      footer={buttons}
      centered
      maskClosable={false}
      forceRender
      onCancel={() => handleCancel(false)}
      confirmLoading={loading}
    >
      <Form form={form} layout="vertical" name="form_in_label_modal">
        <Form.Item name="labels" label={intl.get('标签')}>
          <EditableTagGroup />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export { CronLabelModal, CronModal as default };
