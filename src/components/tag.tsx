import { Tag, Input } from 'antd';
import { TweenOneGroup } from 'rc-tween-one';
import { PlusOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';

const EditableTagGroup = ({
  value,
  onChange,
}: {
  value?: string[];
  onChange?: (tags: string[]) => void;
}) => {
  const [inputValue, setInputValue] = useState('');
  const [inputVisible, setInputVisible] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const saveInputRef = useRef<any>();

  const handleClose = (removedTag: string) => {
    const _tags = tags.filter((tag) => tag !== removedTag);
    setTags(_tags);
    onChange?.(_tags);
  };

  const showInput = () => {
    setInputVisible(true);
  };

  const handleInputChange = (e) => {
    setInputValue(e.target.value);
  };

  const handleInputConfirm = () => {
    if (inputValue && !tags.includes(inputValue)) {
      setTags([...tags, inputValue]);
      onChange?.([...tags, inputValue]);
    }
    setInputVisible(false);
    setInputValue('');
  };

  const tagChild = tags.map((tag) => {
    const tagElem = (
      <Tag
        closable
        onClose={(e) => {
          e.preventDefault();
          handleClose(tag);
        }}
      >
        {tag}
      </Tag>
    );

    return (
      <span key={tag} style={{ display: 'inline-block', marginBottom: 8 }}>
        {tagElem}
      </span>
    );
  });

  useEffect(() => {
    if (inputVisible && saveInputRef) {
      saveInputRef.current.focus();
    }
  }, [inputVisible]);

  useEffect(() => {
    if (value) {
      setTags(value);
    }
  }, [value]);

  return (
    <>
      <TweenOneGroup
        enter={{
          scale: 0.8,
          opacity: 0,
          type: 'from',
          duration: 100,
        }}
        leave={{ opacity: 0, width: 0, scale: 0, duration: 200 }}
        appear={false}
      >
        {tagChild}
      </TweenOneGroup>
      {inputVisible && (
        <Input
          ref={saveInputRef}
          type="text"
          size="small"
          style={{ width: 78 }}
          value={inputValue}
          onChange={handleInputChange}
          onBlur={handleInputConfirm}
          onPressEnter={handleInputConfirm}
        />
      )}
      {!inputVisible && (
        <Tag
          onClick={showInput}
          style={{ borderStyle: 'dashed', cursor: 'pointer' }}
        >
          <PlusOutlined /> 新建
        </Tag>
      )}
    </>
  );
};

export default EditableTagGroup;
