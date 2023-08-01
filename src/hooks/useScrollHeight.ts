import { RefObject, useState } from 'react';
import useResizeObserver from '@react-hook/resize-observer';

export default <T extends HTMLElement>(target: RefObject<T>) => {
  const [height, setHeight] = useState<number>(0);

  useResizeObserver(target, (entry) => {
    let _height = entry.target.clientHeight;
    if (height !== _height) {
      setHeight(_height);
    }
  });
  return height;
};
