import React, { useContext, useState } from 'react';

import { Button } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

import { JsonSchema } from '../../typings';
import { NodeRenderContext } from '../../context';
import { PropertyEdit } from './property-edit';

export interface PropertiesEditProps {
  value?: Record<string, JsonSchema>;
  onChange: (value: Record<string, JsonSchema>) => void;
  useFx?: boolean;
}

export const PropertiesEdit: React.FC<PropertiesEditProps> = (props) => {
  const value = (props.value || {}) as Record<string, JsonSchema>;
  const { readonly } = useContext(NodeRenderContext);
  const [newProperty, updateNewPropertyFromCache] = useState<{ key: string; value: JsonSchema }>({
    key: '',
    value: { type: 'string' },
  });
  const [newPropertyVisible, setNewPropertyVisible] = useState<boolean>();
  const clearCache = () => {
    updateNewPropertyFromCache({ key: '', value: { type: 'string' } });
    setNewPropertyVisible(false);
  };

  // 替换对象的key时，保持顺序
  const replaceKeyAtPosition = (
    obj: Record<string, any>,
    oldKey: string,
    newKey: string,
    newValue: any
  ) => {
    const keys = Object.keys(obj);
    const index = keys.indexOf(oldKey);

    if (index === -1) {
      // 如果 oldKey 不存在，直接添加到末尾
      return { ...obj, [newKey]: newValue };
    }

    // 在原位置替换
    const newKeys = [...keys.slice(0, index), newKey, ...keys.slice(index + 1)];

    return newKeys.reduce((acc, key) => {
      if (key === newKey) {
        acc[key] = newValue;
      } else {
        acc[key] = obj[key];
      }
      return acc;
    }, {} as Record<string, any>);
  };

  const updateProperty = (
    propertyValue: JsonSchema,
    propertyKey: string,
    newPropertyKey?: string
  ) => {
    if (newPropertyKey) {
      const orderedValue = replaceKeyAtPosition(value, propertyKey, newPropertyKey, propertyValue);
      props.onChange(orderedValue);
    } else {
      const newValue = { ...value };
      newValue[propertyKey] = propertyValue;
      props.onChange(newValue);
    }
  };
  const updateNewProperty = (
    propertyValue: JsonSchema,
    propertyKey: string,
    newPropertyKey?: string
  ) => {
    // const newValue = { ...value }
    if (newPropertyKey) {
      if (!(newPropertyKey in value)) {
        updateProperty(propertyValue, propertyKey, newPropertyKey);
      }
      clearCache();
    } else {
      updateNewPropertyFromCache({
        key: newPropertyKey || propertyKey,
        value: propertyValue,
      });
    }
  };
  return (
    <>
      {Object.keys(props.value || {}).map((key) => {
        const property = (value[key] || {}) as JsonSchema;
        return (
          <PropertyEdit
            key={key}
            propertyKey={key}
            useFx={props.useFx}
            value={property}
            disabled={readonly}
            onChange={updateProperty}
            onDelete={() => {
              const newValue = { ...value };
              delete newValue[key];
              props.onChange(newValue);
            }}
          />
        );
      })}
      {newPropertyVisible && (
        <PropertyEdit
          propertyKey={newProperty.key}
          value={newProperty.value}
          useFx={props.useFx}
          onChange={updateNewProperty}
          onDelete={() => {
            const key = newProperty.key;
            // after onblur
            setTimeout(() => {
              const newValue = { ...value };
              delete newValue[key];
              props.onChange(newValue);
              clearCache();
            }, 10);
          }}
        />
      )}
      {!readonly && (
        <div>
          <Button
            type="link"
            icon={<PlusOutlined />}
            onClick={() => setNewPropertyVisible(true)}
          >
            Add
          </Button>
        </div>
      )}
    </>
  );
};
