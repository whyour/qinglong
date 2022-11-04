import { MutableRefObject, useLayoutEffect, useState } from 'react';
import useResizeObserver from '@react-hook/resize-observer'
import { getTableScroll } from '@/utils';

export default <T extends HTMLElement>(target: MutableRefObject<T>, extraHeight?: number) => {
  const [height, setHeight] = useState<number>()

  useResizeObserver(target, (entry) => {
    let _targe = entry.target as any
    if (!_targe.classList.contains('ant-table-wrapper')) {
      _targe = entry.target.querySelector('.ant-table-wrapper')
    }
    setHeight(getTableScroll({ extraHeight, target: _targe as HTMLElement }))
  })
  return height
}