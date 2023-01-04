import React, { useEffect, useRef } from 'react';
import './index.less';

export enum LineType {
  Input,
  Output,
}

export enum ColorMode {
  Light,
  Dark,
}

export interface Props {
  name?: string;
  prompt?: string;
  colorMode?: ColorMode;
  lineData: Array<{ type: LineType; value: string | React.ReactNode }>;
  startingInputValue?: string;
}

const Terminal = ({
  name,
  prompt,
  colorMode,
  lineData,
  startingInputValue = '',
}: Props) => {
  const lastLineRef = useRef<null | HTMLElement>(null);

  // An effect that handles scrolling into view the last line of terminal input or output
  const performScrolldown = useRef(false);
  useEffect(() => {
    if (performScrolldown.current) {
      // skip scrolldown when the component first loads
      setTimeout(
        () =>
          lastLineRef?.current?.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
          }),
        500,
      );
    }
    performScrolldown.current = true;
  }, [lineData.length]);

  const renderedLineData = lineData.map((ld, i) => {
    const classes = ['react-terminal-line'];
    if (ld.type === LineType.Input) {
      classes.push('react-terminal-input');
    }
    // `lastLineRef` is used to ensure the terminal scrolls into view to the last line; make sure to add the ref to the last
    if (lineData.length === i + 1) {
      return (
        <span className={classes.join(' ')} key={i} ref={lastLineRef}>
          {ld.value}
        </span>
      );
    } else {
      return (
        <span className={classes.join(' ')} key={i}>
          {ld.value}
        </span>
      );
    }
  });

  const classes = ['react-terminal-wrapper'];
  if (colorMode === ColorMode.Light) {
    classes.push('react-terminal-light');
  }
  return (
    <div className={classes.join(' ')} data-terminal-name={name}>
      <div className="react-terminal">{renderedLineData}</div>
    </div>
  );
};

export default Terminal;
