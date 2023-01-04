import { useMemo, useState } from 'react';

export default (
  treeData: any[],
  searchValue: string,
  {
    treeNodeFilterProp,
  }: {
    treeNodeFilterProp: string;
  },
) => {
  return useMemo(() => {
    const keys: string[] = [];

    if (!searchValue) {
      return { treeData, keys };
    }

    const upperStr = searchValue.toUpperCase();
    function filterOptionFunc(_: string, dataNode: any[]) {
      const value = dataNode[treeNodeFilterProp as any];

      return String(value).toUpperCase().includes(upperStr);
    }

    function dig(list: any[], keepAll: boolean = false): any[] {
      return list
        .map((dataNode) => {
          const children = dataNode.children;

          const match = keepAll || filterOptionFunc!(searchValue, dataNode);
          const childList = dig(children || [], match);

          if (match || childList.length) {
            childList.length && keys.push(dataNode.key);
            return {
              ...dataNode,
              children: childList,
            };
          }
          return null;
        })
        .filter((node) => node);
    }

    return { treeData: dig(treeData), keys };
  }, [treeData, searchValue, treeNodeFilterProp]);
};
