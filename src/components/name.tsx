import { useRequest } from 'ahooks';
import { Service, Options } from 'ahooks/lib/useRequest/src/types';
import { Spin, Typography } from 'antd';

export default function Name<
  TData extends { data?: { name: string } },
  TParams,
>({
  service,
  options,
}: {
  service: Service<TData, [TParams]>;
  options: Options<TData, [TParams]>;
}) {
  const { loading, data } = useRequest(service, options);

  return (
    <Spin spinning={loading}>
      <Typography.Text ellipsis={true}>{data?.data?.name}</Typography.Text>
    </Spin>
  );
}
