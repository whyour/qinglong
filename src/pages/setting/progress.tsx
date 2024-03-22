import intl from 'react-intl-universal';
import { Modal, Progress } from 'antd';
import { useRef } from 'react';

const ProgressElement = ({ percent }: { percent: number }) => (
  <Progress
    style={{ display: 'flex', justifyContent: 'center' }}
    type="circle"
    percent={percent}
  />
);

export default function useProgress(title: string) {
  const modalRef = useRef<ReturnType<typeof Modal.info> | null>();

  const showProgress = (percent: number) => {
    if (modalRef.current) {
      modalRef.current.update({
        title: `${title}${
          percent >= 100 ? intl.get('成功') : intl.get('中...')
        }`,
        content: <ProgressElement percent={percent} />,
        okButtonProps: { disabled: percent !== 100 },
      });
      if (percent === 100) {
        setTimeout(() => {
          modalRef.current?.destroy();
          modalRef.current = null;
        });
      }
    } else {
      modalRef.current = Modal.info({
        width: 600,
        maskClosable: false,
        title: `${title}${
          percent >= 100 ? intl.get('成功') : intl.get('中...')
        }`,
        centered: true,
        content: <ProgressElement percent={percent} />,
        okButtonProps: { disabled: true },
      });
    }
  };

  return showProgress;
}
