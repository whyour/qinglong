import React, { useState, useRef, useEffect, useCallback } from 'react';

import { Input } from 'antd';
import { TextAreaProps } from 'antd/lib/input';

interface Props {
  value: string | undefined;
  onChange: (data: string | undefined) => void;
  onBlur: () => void;
  onFocus?: () => void;
  onSubmit?: () => void;
  editing?: boolean;
}

const BaseTextarea: React.FC<Props & TextAreaProps> = (props) => {
  const { value, onChange, onBlur, editing, onFocus, autoSize = true, ...rest } = props;

  const [data, setData] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const onSubmit = useCallback(() => {
    onChange(data);
    onBlur?.();
  }, [data, onChange]);

  const handleBlur = () => {
    onBlur?.();
    onSubmit?.();
  };

  useEffect(() => {
    setData(value);
  }, [value]);

  useEffect(() => {
    if (textareaRef.current && editing) {
      textareaRef.current?.focus();
    }
  }, [editing]);

  return (
    <Input.TextArea
      {...rest}
      ref={textareaRef}
      value={data}
      onChange={(e) => {
        setData(e.target.value);
      }}
      onPressEnter={onSubmit}
      onBlur={handleBlur}
      onFocus={onFocus}
      autoSize={autoSize}
      rows={1}
      className={'base-textarea'}
    />
  );
};

export default BaseTextarea;
