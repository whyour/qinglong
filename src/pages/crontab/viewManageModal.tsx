import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  message,
  Space,
  Table,
  Tag,
  Typography,
  Button,
  Switch,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import ViewCreateModal from './viewCreateModal';

const { Text } = Typography;

const type = 'DragableBodyRow';

const DragableBodyRow = ({
  index,
  moveRow,
  className,
  style,
  ...restProps
}: any) => {
  const ref = useRef();
  const [{ isOver, dropClassName }, drop] = useDrop({
    accept: type,
    collect: (monitor) => {
      const { index: dragIndex } = (monitor.getItem() as any) || {};
      if (dragIndex === index) {
        return {};
      }
      return {
        isOver: monitor.isOver(),
        dropClassName:
          dragIndex < index ? ' drop-over-downward' : ' drop-over-upward',
      };
    },
    drop: (item: any) => {
      moveRow(item.index, index);
    },
  });
  const [, drag] = useDrag({
    type,
    item: { index },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });
  drop(drag(ref));

  return (
    <tr
      ref={ref}
      className={`${className}${isOver ? dropClassName : ''}`}
      style={{ cursor: 'move', ...style }}
      {...restProps}
    />
  );
};

const ViewManageModal = ({
  cronViews,
  handleCancel,
  visible,
  cronViewChange,
}: {
  cronViews: any[];
  visible: boolean;
  handleCancel: () => void;
  cronViewChange: (data?: any) => void;
}) => {
  const columns: any = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      align: 'center' as const,
      render: (text) => (
        <div style={{ textAlign: 'left', paddingLeft: 30 }}>{text}</div>
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      align: 'center' as const,
      render: (v) => (v === 1 ? '系统' : '个人'),
    },
    {
      title: '显示',
      key: 'isDisabled',
      dataIndex: 'isDisabled',
      align: 'center' as const,
      width: 100,
      render: (text: string, record: any, index: number) => {
        return (
          <Switch
            checked={!record.isDisabled}
            onChange={(checked) => onShowChange(checked, record, index)}
          />
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      align: 'center' as const,
      render: (text: string, record: any, index: number) => {
        return record.type !== 1 ? (
          <Space size="middle">
            <a onClick={() => editView(record, index)}>
              <EditOutlined />
            </a>
            <a onClick={() => deleteView(record, index)}>
              <DeleteOutlined />
            </a>
          </Space>
        ) : (
          '-'
        );
      },
    },
  ];
  const [list, setList] = useState<any[]>([]);
  const [isCreateViewModalVisible, setIsCreateViewModalVisible] =
    useState<boolean>(false);
  const [editedView, setEditedView] = useState<any>(null);

  const editView = (record: any, index: number) => {
    setEditedView(record);
    setIsCreateViewModalVisible(true);
  };

  const deleteView = (record: any, index: number) => {
    Modal.confirm({
      title: '确认删除',
      content: (
        <>
          确认删除视图{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {record.name}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}crons/views`, { data: [record.id] })
          .then(({ code, data }) => {
            if (code === 200) {
              message.success('删除成功');
              cronViewChange();
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const onShowChange = (checked: boolean, record: any, index: number) => {
    request
      .put(`${config.apiPrefix}crons/views/${checked ? 'enable' : 'disable'}`, {
        data: [record.id],
      })
      .then(({ code, data }) => {
        if (code === 200) {
          const _list = [...list];
          _list.splice(index, 1, { ...list[index], isDisabled: !checked });
          setList(_list);
          cronViewChange();
        }
      });
  };

  const components = {
    body: {
      row: DragableBodyRow,
    },
  };

  const moveRow = useCallback(
    (dragIndex, hoverIndex) => {
      if (dragIndex === hoverIndex) {
        return;
      }
      const dragRow = list[dragIndex];
      request
        .put(`${config.apiPrefix}crons/views/move`, {
          data: { fromIndex: dragIndex, toIndex: hoverIndex, id: dragRow.id },
        })
        .then(({ code, data }) => {
          if (code === 200) {
            const newData = [...list];
            newData.splice(dragIndex, 1);
            newData.splice(hoverIndex, 0, { ...dragRow, ...data });
            setList(newData);
            cronViewChange();
          }
        });
    },
    [list],
  );

  useEffect(() => {
    setList(cronViews);
  }, [cronViews]);

  return (
    <Modal
      title="视图管理"
      open={visible}
      centered
      width={620}
      onCancel={() => handleCancel()}
      className="view-manage-modal"
      forceRender
      footer={false}
      maskClosable={false}
    >
      <Space
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginBottom: 10,
        }}
      >
        <Button
          key="2"
          type="primary"
          onClick={() => {
            setEditedView(null);
            setIsCreateViewModalVisible(true);
          }}
        >
          新建视图
        </Button>
      </Space>
      <DndProvider backend={HTML5Backend}>
        <Table
          bordered
          columns={columns}
          pagination={false}
          dataSource={list}
          rowKey="id"
          size="middle"
          style={{ marginBottom: 20 }}
          components={components}
          onRow={(record: any, index: number) => {
            return {
              index,
              moveRow,
            } as any;
          }}
        />
      </DndProvider>
      <ViewCreateModal
        view={editedView}
        visible={isCreateViewModalVisible}
        handleCancel={(data) => {
          setIsCreateViewModalVisible(false);
          cronViewChange(data);
        }}
      />
    </Modal>
  );
};

export default ViewManageModal;
