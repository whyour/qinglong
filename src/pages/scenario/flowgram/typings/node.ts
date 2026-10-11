import { IFlowValue } from '@flowgram.ai/form-materials';
import {
  FlowNodeJSON as FlowNodeJSONDefault,
  FlowNodeRegistry as FlowNodeRegistryDefault,
  FixedLayoutPluginContext,
  FlowNodeEntity,
  FlowNodeMeta as FlowNodeMetaDefault,
} from '@flowgram.ai/fixed-layout-editor';

import { type JsonSchema } from './json-schema';

/**
 * You can customize the data of the node, and here you can use JsonSchema to define the input and output of the node
 * 你可以自定义节点的 data 业务数据, 这里演示 通过 JsonSchema 来定义节点的输入/输出
 */
export interface FlowNodeJSON extends FlowNodeJSONDefault {
  data: {
    /**
     * Node title
     */
    title?: string;
    /**
     * Inputs data values
     */
    inputsValues?: Record<string, IFlowValue>;
    /**
     * Define the inputs data of the node by JsonSchema
     */
    inputs?: JsonSchema;
    /**
     * Define the outputs data of the node by JsonSchema
     */
    outputs?: JsonSchema;
    /**
     * Rest properties
     */
    [key: string]: any;
  };
}

/**
 * You can customize your own node meta
 * 你可以自定义节点的meta
 */
export interface FlowNodeMeta extends FlowNodeMetaDefault {
  sidebarDisable?: boolean;
  style?: React.CSSProperties;
}
/**
 * You can customize your own node registry
 * 你可以自定义节点的注册器
 */
export interface FlowNodeRegistry extends FlowNodeRegistryDefault {
  meta?: FlowNodeMeta;
  info: {
    icon: string;
    description: string;
  };
  canAdd?: (ctx: FixedLayoutPluginContext, from: FlowNodeEntity) => boolean;
  canDelete?: (ctx: FixedLayoutPluginContext, from: FlowNodeEntity) => boolean;
  onAdd?: (ctx: FixedLayoutPluginContext, from: FlowNodeEntity) => FlowNodeJSON;
}

export type FlowDocumentJSON = {
  nodes: FlowNodeJSON[];
};
