import React, { useState, useCallback, useRef, type CSSProperties } from 'react';

import styled from 'styled-components';

import BaseTextarea from './base-textarea';

import './index.css';
import { TextAreaProps } from 'antd/lib/input';

const OverlayWrap = styled.div`
  width: 100%;
`;

interface Props {
  value?: string;
  readonly?: boolean;
  placeholder?: string;
  autoSize?: TextAreaProps['autoSize'];
  style?: CSSProperties;
  onChange: (data?: string) => void;
  onEditingChange?: (editing: boolean) => void;
}

const MultiLineEditor: React.FC<Props> = (props) => {
  const {
    value,
    onChange,
    onEditingChange,
    readonly,
    autoSize,
    placeholder = '',
    style = {},
  } = props;

  const [editing, setEditing] = useState<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(null);

  const handleEdit = useCallback(() => {
    if (readonly) {
      return;
    }
    setEditing(true);
    onEditingChange?.(true);
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
  }, [readonly]);

  const handleEditEnd = useCallback(() => {
    setEditing(false);
    onEditingChange?.(false);
  }, []);

  return (
    <OverlayWrap className="multilang-textarea-editor">
      {editing && !readonly ? (
        <BaseTextarea
          ref={textareaRef}
          value={value}
          onChange={onChange}
          editing={editing}
          onBlur={handleEditEnd}
          onSubmit={handleEditEnd}
          placeholder={placeholder}
          autoSize={autoSize}
        />
      ) : (
        <div
          ref={textRef}
          className={'node-description'}
          onClick={handleEdit}
          style={readonly ? { paddingLeft: 0, ...style } : style}
        >
          {value || placeholder}
        </div>
      )}
    </OverlayWrap>
  );
};

export default MultiLineEditor;
