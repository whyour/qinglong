import { Modal, message } from 'antd';
import intl from 'react-intl-universal';
import { IResponseData, request } from '@/utils/http';

/** Shared by the editor and debugger, so neither can silently skip history. */
export async function saveWithHistory(
  method: 'put' | 'post',
  url: string,
  payload: Record<string, unknown>,
): Promise<IResponseData | undefined> {
  const send = async (options: Record<string, unknown> = {}) => {
    const result = await request[method](
      url,
      { ...payload, ...options },
      {
        onError: (response) => Promise.reject({ response }),
      },
    );
    if (result.code !== 200)
      throw new Error(result.message || intl.get('保存失败'));
    return result;
  };
  const report = (error: any) =>
    message.error(
      error?.response?.data?.message || error?.message || intl.get('保存失败'),
    );
  let result: IResponseData | undefined;
  try {
    result = await send();
  } catch (error: any) {
    const response = error?.response;
    if (response?.status !== 413 || !response.data?.historyUnavailable) {
      report(error);
      return undefined;
    }
    result = await new Promise<IResponseData | undefined>((resolve) => {
      const confirmation = Modal.confirm({
        title: intl.get('不记录历史直接保存？'),
        content: intl.get(
          '当前文件或新内容超出历史记录范围，本次覆盖前的内容不会保留。',
        ),
        okText: intl.get('仍然保存'),
        maskClosable: false,
        onCancel: () => resolve(undefined),
        onOk: async () => {
          confirmation.update({
            cancelButtonProps: { disabled: true },
            keyboard: false,
          });
          try {
            const saved = await send({
              skipHistory: true,
              expectedHash: response.data.currentHash,
            });
            resolve(saved);
          } catch (failure) {
            report(failure);
            // Close the confirmation and release the editor. A conflict needs a
            // fresh read, not another retry with the stale confirmation hash.
            resolve(undefined);
          }
        },
      });
    });
  }
  if (result?.data?.historyRecorded === false) {
    message.warning(intl.get('已保存，本次未记录历史版本'));
  } else if (result?.data?.cleanupPending) {
    message.warning(intl.get('已保存，但旧历史清理失败，请检查存储权限和空间'));
  } else if (result) {
    message.success(intl.get('保存成功'));
  }
  return result;
}
