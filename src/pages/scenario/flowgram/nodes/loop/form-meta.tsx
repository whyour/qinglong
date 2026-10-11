import {
  BatchVariableSelector,
  IFlowRefValue,
  provideBatchInputEffect,
} from '@flowgram.ai/form-materials';
import { FormRenderProps, FlowNodeJSON, Field, FormMeta } from '@flowgram.ai/fixed-layout-editor';

import { useIsSidebar, useNodeRenderContext } from '../../hooks';
import { FormHeader, FormContent, FormOutputs, FormItem, Feedback } from '../../form-components';

interface LoopNodeJSON extends FlowNodeJSON {
  data: {
    loopFor: IFlowRefValue;
  };
}

export const LoopFormRender = ({ form }: FormRenderProps<LoopNodeJSON>) => {
  const isSidebar = useIsSidebar();
  const { readonly } = useNodeRenderContext();

  const loopFor = (
    <Field<IFlowRefValue> name={`loopFor`}>
      {({ field, fieldState }) => (
        <FormItem name={'loopFor'} type={'array'} required>
          <BatchVariableSelector
            style={{ width: '100%' }}
            value={field.value?.content}
            onChange={(val) => field.onChange({ type: 'ref', content: val })}
            readonly={readonly}
            hasError={Object.keys(fieldState?.errors || {}).length > 0}
          />
          <Feedback errors={fieldState?.errors} />
        </FormItem>
      )}
    </Field>
  );

  if (isSidebar) {
    return (
      <>
        <FormHeader />
        <FormContent>
          {loopFor}
          <FormOutputs />
        </FormContent>
      </>
    );
  }
  return (
    <>
      <FormHeader />
      <FormContent>
        {loopFor}
        <FormOutputs />
      </FormContent>
    </>
  );
};

export const formMeta: FormMeta<LoopNodeJSON['data']> = {
  render: LoopFormRender,
  effect: {
    loopFor: provideBatchInputEffect,
  },
};
