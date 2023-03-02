import React, {
  useRef,
  useEffect,
  useContext,
  createContext,
  useReducer,
  useState,
  useMemo,
} from 'react';
import { throttle, isNumber, debounce } from 'lodash';

const initialState = {
  // 行高度
  rowHeight: 0,
  // 当前的scrollTop
  curScrollTop: 0,
  // 总行数
  totalLen: 0,
};

function reducer(state, action) {
  const { curScrollTop, totalLen, ifScrollTopClear, scrollTop } = action;

  let stateScrollTop = state.curScrollTop;
  switch (action.type) {
    // 改变trs 即 改变渲染的列表trs
    case 'changeTrs':
      return {
        ...state,
        curScrollTop,
      };
    // 更改totalLen
    case 'changeTotalLen':
      if (totalLen === 0) {
        stateScrollTop = 0;
      }

      return {
        ...state,
        totalLen,
        curScrollTop: stateScrollTop,
      };

    case 'reset':
      return {
        ...state,
        curScrollTop: ifScrollTopClear ? 0 : scrollTop ?? state.curScrollTop,
      };
    default:
      throw new Error();
  }
}

// ==============全局常量 ================== //
const DEFAULT_VID = 'vtable';
const vidMap = new Map();
let preData = 0;

// ===============context ============== //
const ScrollContext = createContext({
  dispatch: undefined,
  renderLen: 1,
  start: 0,
  offsetStart: 0,
  // =============
  rowHeight: initialState.rowHeight,
  totalLen: 0,
  vid: DEFAULT_VID,
});

// =============组件 =================== //

function VCell(props: any): JSX.Element {
  const { children, ...restProps } = props;

  return (
    <td {...restProps}>
      <div>{children[1]}</div>
    </td>
  );
}

function VRow(props: any, ref: any): JSX.Element {
  const { rowHeight } = useContext(ScrollContext);

  const { children, style, ...restProps } = props;

  const trRef = useRef<HTMLTableRowElement>(null);

  return (
    <tr
      {...restProps}
      ref={Object.prototype.hasOwnProperty.call(ref, 'current') ? ref : trRef}
      style={{
        ...style,
        height: rowHeight || 'auto',
        boxSizing: 'border-box',
      }}
    >
      {children}
    </tr>
  );
}

function VWrapper(props: any): JSX.Element {
  const { children, ...restProps } = props;

  const { renderLen, start, dispatch, vid, totalLen } =
    useContext(ScrollContext);

  const contents = useMemo(() => {
    return children[1];
  }, [children]);

  const contentsLen = useMemo(() => {
    return contents?.length ?? 0;
  }, [contents]);

  useEffect(() => {
    if (totalLen !== contentsLen) {
      dispatch({
        type: 'changeTotalLen',
        totalLen: contentsLen ?? 0,
      });
    }
  }, [contentsLen, dispatch, vid, totalLen]);

  let tempNode = null;
  if (Array.isArray(contents) && contents.length) {
    tempNode = [
      children[0],
      contents.slice(start, start + (renderLen ?? 1)).map((item) => {
        if (Array.isArray(item)) {
          // 兼容antd v4.3.5 --- rc-table 7.8.1及以下
          return item[0];
        }
        // 处理antd ^v4.4.0  --- rc-table ^7.8.2
        return item;
      }),
    ];
  } else {
    tempNode = children;
  }

  return <tbody {...restProps}>{tempNode}</tbody>;
}

function VTable(props: any, otherParams): JSX.Element {
  const { style, children, ...rest } = props;
  const { width, ...rest_style } = style;

  const { vid, scrollY, resetScrollTopWhenDataChange, rowHeight, scrollTop } =
    otherParams ?? {};

  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    curScrollTop: scrollTop,
    rowHeight,
  });

  const wrap_tableRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  const ifChangeRef = useRef(false);

  // 数据的总条数
  const [totalLen, setTotalLen] = useState<number>(
    children[1]?.props?.data?.length ?? 0,
  );

  useEffect(() => {
    setTotalLen(state.totalLen);
  }, [state.totalLen]);

  // 组件卸载的清除操作
  useEffect(() => {
    return () => {
      vidMap.delete(vid);
    };
  }, [vid]);

  // 数据变更
  useEffect(() => {
    ifChangeRef.current = true;
    // console.log('数据变更')
    if (isNumber(children[1]?.props?.data?.length)) {
      dispatch({
        type: 'changeTotalLen',
        totalLen: children[1]?.props?.data?.length ?? 0,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children[1].props.data]);

  // table总高度
  const tableHeight = useMemo<string | number>(() => {
    let temp: string | number = 'auto';

    if (rowHeight && totalLen) {
      temp = rowHeight * totalLen;
    }
    return temp;
  }, [totalLen]);

  // table的scrollY值
  const [tableScrollY, setTableScrollY] = useState(0);

  // tableScrollY 随scrollY / tableHeight 进行变更
  useEffect(() => {
    let temp = 0;

    if (typeof scrollY === 'string') {
      temp =
        (wrap_tableRef.current?.parentNode as HTMLElement)?.offsetHeight ?? 0;
    } else {
      temp = scrollY;
    }

    // if (isNumber(tableHeight) && tableHeight < temp) {
    //   temp = tableHeight;
    // }

    // 处理tableScrollY <= 0的情况
    if (temp <= 0) {
      temp = 0;
    }

    setTableScrollY(temp);
  }, [scrollY, tableHeight]);

  // 渲染的条数
  const renderLen = useMemo<number>(() => {
    let temp = 1;
    if (rowHeight && totalLen && tableScrollY) {
      if (tableScrollY <= 0) {
        temp = 0;
      } else {
        const tempRenderLen = ((tableScrollY / rowHeight) | 0) + 10;
        // console.log('tempRenderLen', tempRenderLen)
        // temp = tempRenderLen > totalLen ? totalLen : tempRenderLen;
        temp = tempRenderLen;
      }
    }

    return temp;
  }, [totalLen, tableScrollY]);

  // 渲染中的第一条
  let start = rowHeight ? (state.curScrollTop / rowHeight) | 0 : 0;

  start = start < 5 ? 0 : start - 5 + 1;

  // 偏移量
  let offsetStart = state.curScrollTop % (rowHeight * 5);

  if (start > 0) {
    offsetStart = offsetStart % rowHeight;
  }
  // console.log(offsetStart)
  // offsetStart= offsetStart%rowHeight
  // 用来优化向上滚动出现的空白
  if (state.curScrollTop && state.curScrollTop >= rowHeight * 5) {
    // start -= 1
    // if (offsetStart >= rowHeight) {
    //   offsetStart +=
    // } else {
    offsetStart += rowHeight * 4;
    // }
  } else {
    start = 0;
  }

  // console.log(state.curScrollTop, start, offsetStart)

  // 数据变更 操作scrollTop
  useEffect(() => {
    const scrollNode = wrap_tableRef.current?.parentNode as HTMLElement;
    if (ifChangeRef?.current) {
      // console.log(scrollNode)
      ifChangeRef.current = false;

      if (resetScrollTopWhenDataChange) {
        // 重置scrollTop
        if (scrollNode) {
          scrollNode.scrollTop = 0;
        }

        dispatch({ type: 'reset', ifScrollTopClear: true });
      } else {
        // console.log(preData)
        // scrollNode.scrollTop = preData+53
        // 不重置scrollTop 不清空curScrollTop
        dispatch({ type: 'reset', ifScrollTopClear: false });
      }
    }

    if (vidMap.has(vid)) {
      vidMap.set(vid, {
        ...vidMap.get(vid),
        scrollNode,
      });
    }
  }, [totalLen, resetScrollTopWhenDataChange, vid, children]);

  useEffect(() => {
    const throttleScroll = throttle((e) => {
      const scrollTop: number = e?.target?.scrollTop ?? 0;
      // const scrollHeight: number = e?.target?.scrollHeight ?? 0
      // const clientHeight: number = e?.target?.clientHeight ?? 0
      if (scrollTop) {
        preData = scrollTop;
      }
      // 到底了 没有滚动条就不会触发reachEnd. 建议设置scrolly高度少点或者数据量多点.
      // 若renderLen大于totalLen, 置空curScrollTop. => table paddingTop会置空.
      dispatch({
        type: 'changeTrs',
        curScrollTop: renderLen <= totalLen ? scrollTop : 0,
      });
    }, 60);

    const ref = wrap_tableRef?.current?.parentNode as HTMLElement;

    if (ref) {
      ref.addEventListener('scroll', throttleScroll, { passive: true });
    }

    return () => {
      ref.removeEventListener('scroll', throttleScroll);
    };
  }, [renderLen, totalLen]);

  return (
    <div
      className="virtuallist"
      ref={wrap_tableRef}
      style={{
        width: '100%',
        position: 'relative',
        height: tableHeight,
        boxSizing: 'border-box',
        paddingTop: state.curScrollTop,
      }}
    >
      <ScrollContext.Provider
        value={{
          dispatch,
          start,
          offsetStart,
          renderLen,
          totalLen,
          vid,
          rowHeight,
        }}
      >
        <table
          {...rest}
          ref={tableRef}
          style={{
            ...rest_style,
            width,
            position: 'relative',
            transform: `translateY(-${offsetStart}px)`,
          }}
        >
          {children}
        </table>
      </ScrollContext.Provider>
    </div>
  );
}

// ================导出===================
export function VList(props: {
  height: number;
  // 唯一标识
  vid?: string;
  rowHeight: number | string;
  reset?: boolean;
  scrollTop?: number | string;
}): any {
  const { vid = DEFAULT_VID, rowHeight, height, reset, scrollTop } = props;

  const resetScrollTopWhenDataChange = reset ?? true;

  if (!vidMap.has(vid)) {
    vidMap.set(vid, { _id: vid });
  }

  return {
    table: (p) =>
      VTable(p, {
        vid,
        scrollY: height,
        rowHeight,
        resetScrollTopWhenDataChange,
        scrollTop,
      }),
    body: {
      wrapper: VWrapper,
      row: VRow,
      cell: VCell,
    },
  };
}
