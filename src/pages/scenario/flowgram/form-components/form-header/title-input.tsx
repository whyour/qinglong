import { useRef, useEffect } from 'react';

import { Field, FieldRenderProps } from '@flowgram.ai/fixed-layout-editor';
import { Typography, Input } from 'antd';

import { Title } from './styles';
import { Feedback } from '../feedback';
const { Text } = Typography;

export function TitleInput(props: {
  readonly: boolean;
  titleEdit: boolean;
  updateTitleEdit: (setEdit: boolean) => void;
}): JSX.Element {
  const { readonly, titleEdit, updateTitleEdit } = props;
  const ref = useRef<any>();
  const titleEditing = titleEdit && !readonly;
  useEffect(() => {
    if (titleEditing) {
      ref.current?.focus();
    }
  }, [titleEditing]);

  return (
    <Title>
      <Field name="title">
        {({ field: { value, onChange }, fieldState }: FieldRenderProps<string>) => (
          <div style={{ height: 24 }}>
            {titleEditing ? (
              <Input
                value={value}
                onChange={onChange}
                ref={ref}
                onBlur={() => updateTitleEdit(false)}
              />
            ) : (
              <Text ellipsis={{ tooltip: true }}>{value}</Text>
            )}
            <Feedback errors={fieldState?.errors} />
          </div>
        )}
      </Field>
    </Title>
  );
}
