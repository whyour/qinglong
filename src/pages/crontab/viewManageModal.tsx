import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, message, Space, Table, Tag, Typography, Button } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { PageLoading } from '@ant-design/pro-layout';
import Paragraph from 'antd/lib/skeleton/Paragraph';
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
  handleCancel,
  visible,
}: {
  visible: boolean;
  handleCancel: () => void;
}) => {
  const columns: any = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      align: 'center' as const,
      width: 70,
    },
    {
      title: '显示',
      key: 'status',
      dataIndex: 'status',
      align: 'center' as const,
      width: 70,
      render: (text: string, record: any, index: number) => {
        return <Space size="middle" style={{ cursor: 'text' }}></Space>;
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      align: 'center' as const,
      render: (text: string, record: any, index: number) => {
        return (
          <Space size="middle">
            <a onClick={() => editView(record, index)}>
              <EditOutlined />
            </a>
            <a onClick={() => deleteView(record, index)}>
              <DeleteOutlined />
            </a>
          </Space>
        );
      },
    },
  ];
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState<any>(true);
  const [isCreateViewModalVisible, setIsCreateViewModalVisible] =
    useState<boolean>(false);

  const editView = (record: any, index: number) => {
    // setEditedEnv(record);
    // setIsModalVisible(true);
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
          .then((data: any) => {
            if (data.code === 200) {
              message.success('删除成功');
              const result = [...list];
              result.splice(index, 1);
              setList(result);
            } else {
              message.error(data);
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const getCronViews = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}crons/views`)
      .then((data: any) => {
        console.log(data);
      })
      .finally(() => {
        setLoading(false);
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
        .put(`${config.apiPrefix}envs/${dragRow.id}/move`, {
          data: { fromIndex: dragIndex, toIndex: hoverIndex },
        })
        .then((data: any) => {
          if (data.code === 200) {
            const newData = [...list];
            newData.splice(dragIndex, 1);
            newData.splice(hoverIndex, 0, { ...dragRow, ...data.data });
            setList(newData);
          } else {
            message.error(data);
          }
        });
    },
    [list],
  );

  useEffect(() => {
    // getCronViews();
  }, []);

  return (
    <Modal
      title="视图管理"
      visible={visible}
      centered
      width={620}
      onCancel={() => handleCancel()}
      className="view-manage-modal"
      forceRender
      footer={false}
      maskClosable={false}
    >
      <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          key="2"
          type="primary"
          onClick={() => setIsCreateViewModalVisible(true)}
        >
          新建视图
        </Button>
      </Space>
      {loading ? (
        <PageLoading />
      ) : (
        <DndProvider backend={HTML5Backend}>
          <Table
            columns={columns}
            pagination={false}
            dataSource={list}
            rowKey="id"
            size="middle"
            components={components}
            loading={loading}
            onRow={(record: any, index: number) => {
              return {
                index,
                moveRow,
              } as any;
            }}
          />
        </DndProvider>
      )}
      <ViewCreateModal
        visible={isCreateViewModalVisible}
        handleCancel={() => {
          setIsCreateViewModalVisible(false);
        }}
      />
    </Modal>
  );
};

export default ViewManageModal;
