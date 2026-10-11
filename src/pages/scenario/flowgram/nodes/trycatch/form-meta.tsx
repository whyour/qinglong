import { FormRenderProps, FormMeta, ValidateTrigger } from '@flowgram.ai/fixed-layout-editor';

import { FlowNodeJSON } from '../../typings';
import { FormHeader, FormContent, FormOutputs } from '../../form-components';

export const renderForm = ({ form }: FormRenderProps<FlowNodeJSON['data']>) => (
  <>
    <FormHeader />
    <FormContent>
      <FormOutputs />
    </FormContent>
  </>
);

export const formMeta: FormMeta<FlowNodeJSON['data']> = {
  render: renderForm,
  validateTrigger: ValidateTrigger.onChange,
  validate: {
    title: ({ value }: { value: string }) => (value ? undefined : 'Title is required'),
  },
};
