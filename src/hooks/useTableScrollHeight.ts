import { RefObject, useState } from 'react';
import useResizeObserver from '@react-hook/resize-observer';
import { getTableScroll } from '@/utils';

export default <T extends HTMLElement>(
  target: RefObject<T>,
  extraHeight?: number,
) => {
  const [height, setHeight] = useState<number>(0);

  useResizeObserver(target, (entry) => {
    let _target = entry.target as any;
    if (!_target.classList.contains('ant-table-wrapper')) {
      _target = entry.target.querySelector('.ant-table-wrapper');
    }
    setHeight(getTableScroll({ extraHeight, target: _target as HTMLElement }));
  });
  return height;
};
