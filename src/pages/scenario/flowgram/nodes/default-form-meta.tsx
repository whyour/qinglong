import {
  autoRenameRefEffect,
  provideJsonSchemaOutputs,
  syncVariableTitle,
} from '@flowgram.ai/form-materials';
import {
  FormRenderProps,
  FormMeta,
  ValidateTrigger,
  FeedbackLevel,
} from '@flowgram.ai/fixed-layout-editor';

import { FlowNodeJSON } from '../typings';
import { FormHeader, FormContent, FormInputs, FormOutputs } from '../form-components';

export const renderForm = ({ form }: FormRenderProps<FlowNodeJSON['data']>) => (
  <>
    <FormHeader />
    <FormContent>
      <FormInputs />
      <FormOutputs />
    </FormContent>
  </>
);

export const defaultFormMeta: FormMeta<FlowNodeJSON['data']> = {
  render: renderForm,
  validateTrigger: ValidateTrigger.onChange,
  /**
   * Initialize (fromJSON) data transformation
   * 初始化(fromJSON) 数据转换
   * @param value
   * @param ctx
   */
  formatOnInit: (value, ctx) => value,
  /**
   * Save (toJSON) data transformation
   * 保存(toJSON) 数据转换
   * @param value
   * @param ctx
   */
  formatOnSubmit: (value, ctx) => value,
  /**
   * Supported writing as:
   * 1: validate as options: { title: () => {} , ... }
   * 2: validate as dynamic function: (values,  ctx) => ({ title: () => {}, ... })
   */
  validate: {
    title: ({ value }) => (value ? undefined : 'Title is required'),
    'inputsValues.*': ({ value, context, formValues, name }) => {
      const valuePropetyKey = name.replace(/^inputsValues\./, '');
      const required = formValues.inputs?.required || [];
      if (
        required.includes(valuePropetyKey) &&
        (value === '' || value === undefined || value?.content === '')
      ) {
        return {
          message: `${valuePropetyKey} is required`,
          level: FeedbackLevel.Error, // Error || Warning
        };
      }
      return undefined;
    },
  },
  effect: {
    title: syncVariableTitle,
    outputs: provideJsonSchemaOutputs,
    inputsValues: autoRenameRefEffect,
  },
};
