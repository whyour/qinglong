import intl from 'react-intl-universal';
import { Modal, Progress } from 'antd';
import { useRef } from 'react';

export default function useProgress(title: string) {
  const modalRef = useRef<ReturnType<typeof Modal.info>>();

  const ProgressElement = ({ percent }: { percent: number }) => (
    <Progress
      style={{ display: 'flex', justifyContent: 'center' }}
      type="circle"
      percent={percent}
    />
  );

  const showProgress = (percent: number) => {
    if (modalRef.current) {
      modalRef.current.update({
        title: `${title}${percent >= 100 ? intl.get('成功') : intl.get('中...')}`,
        content: <ProgressElement percent={percent} />,
      });
    } else {
      modalRef.current = Modal.info({
        width: 600,
        maskClosable: false,
        title: `${title}${percent >= 100 ? intl.get('成功') : intl.get('中...')}`,
        centered: true,
        content: <ProgressElement percent={percent} />,
      });
    }
  };

  return showProgress;
}
