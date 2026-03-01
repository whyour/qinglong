import { nanoid } from 'nanoid';
import {
  CommandRegistry,
  type FixedLayoutPluginContext,
  FlowGroupService,
  FlowNodeBaseType,
  FlowNodeEntity,
  FlowNodeRenderData,
  type ShortcutsRegistry,
} from '@flowgram.ai/fixed-layout-editor';
import { message } from 'antd';

import { writeData } from './utils';
import { FlowCommandId } from './constants';

type ShortcutGetter = (
  ctx: FixedLayoutPluginContext
) => Parameters<ShortcutsRegistry['addHandlers']>[0];

const copy: ShortcutGetter = (ctx) => {
  const selection = ctx.selection;
  const clipboard = ctx.clipboard;

  return {
    commandId: FlowCommandId.COPY,
    shortcuts: ['meta c', 'ctrl c'],
    isEnabled: (node) =>
      (selection?.selection.length > 0 || node instanceof FlowNodeEntity) &&
      !ctx.playground.config.readonlyOrDisabled,
    execute: (node) => {
      const nodes =
        node instanceof FlowNodeEntity
          ? [node]
          : (selection.selection.filter(
              (_entity) => _entity instanceof FlowNodeEntity
            ) as FlowNodeEntity[]);
      const originNodes = nodes.map((n) => ({
        ...n.toJSON(),
        id: `${n.flowNodeType}_${nanoid()}`,
      }));

      writeData(originNodes, clipboard);
      message.success({
        content: 'Copied. You can move to any [+] to paste.',
      });
    },
  };
};

const cut: ShortcutGetter = (ctx) => {
  const selection = ctx.selection;

  const commandRegistry = ctx.get<CommandRegistry>(CommandRegistry);

  return {
    commandId: FlowCommandId.CUT,
    commandDetail: {
      label: 'Cut',
    },
    shortcuts: ['meta x', 'ctrl x'],
    isEnabled: () => selection.selection.length > 0 && !ctx.playground.config.readonlyOrDisabled,
    execute: () => {
      // nodeService.copyNodes(
      //   selection.selection.filter(
      //     _entity => _entity instanceof FlowNodeEntity,
      //   ) as FlowNodeEntity[],
      // );

      message.success({
        content: 'Cut. You can move to any [+] to paste.',
      });

      commandRegistry.executeCommand(FlowCommandId.DELETE);
    },
  };
};

const zoomIn: ShortcutGetter = (ctx) => {
  const config = ctx.playground.config;

  return {
    commandId: FlowCommandId.ZOOM_IN,
    shortcuts: ['meta =', 'ctrl ='],
    execute: () => {
      config.zoomin();
    },
  };
};

const zoomOut: ShortcutGetter = (ctx) => {
  const config = ctx.playground.config;

  return {
    commandId: FlowCommandId.ZOOM_OUT,
    shortcuts: ['meta -', 'ctrl -'],
    execute: () => {
      config.zoomout();
    },
  };
};

const resetZoom: ShortcutGetter = (ctx) => ({
  commandId: FlowCommandId.RESET_ZOOM,
  commandDetail: {
    label: 'Reset Zoom',
  },
  shortcuts: ['meta 0', 'ctrl 0'],
  execute: () => {
    ctx.playground.config.updateZoom(1);
  },
});

const group: ShortcutGetter = (ctx) => ({
  commandId: FlowCommandId.GROUP,
  commandDetail: {
    label: 'Create Group',
  },
  shortcuts: ['meta g', 'ctrl g'],
  isEnabled: () => !ctx.playground.config.readonlyOrDisabled,

  execute: () => {
    const groupService = ctx.get<FlowGroupService>(FlowGroupService);
    const selection = ctx.playground.selectionService;

    groupService.createGroup(
      selection.selection.filter((_entity) => _entity instanceof FlowNodeEntity) as FlowNodeEntity[]
    );

    ctx.playground.selectionService.selection = [];
  },
});

const selectAll: ShortcutGetter = (ctx) => ({
  commandId: FlowCommandId.SELECT_ALL,
  commandDetail: {
    label: 'Select All',
  },
  shortcuts: ['meta a', 'ctrl a'],
  isEnabled: () => !ctx.playground.config.readonlyOrDisabled,
  execute: () => {
    const allNodes = (ctx.document.root.children || []).filter(
      (node) => node.flowNodeType !== 'start' && node.flowNodeType !== 'end'
    );

    ctx.playground.selectionService.selection = allNodes;
  },
});

const cancelSelect: ShortcutGetter = (ctx) => ({
  commandId: FlowCommandId.CANCEL_SELECT,
  commandDetail: {
    label: 'Cancel Select',
  },
  shortcuts: ['esc'],
  execute: () => {
    ctx.playground.selectionService.selection = [];
  },
});

const collapse: ShortcutGetter = (ctx) => ({
  commandId: FlowCommandId.COLLAPSE,
  commandDetail: {
    label: 'Collapse',
  },
  shortcuts: ['meta alt openbracket', 'ctrl alt openbracket'],
  isEnabled: () => !ctx.playground.config.readonlyOrDisabled,
  execute: () => {
    const selection = ctx.selection;

    const selectNodes = selection.selection.filter(
      (_entity) => _entity instanceof FlowNodeEntity
    ) as FlowNodeEntity[];

    selectNodes
      .map((_node) => [_node, ..._node.allCollapsedChildren])
      .flat()
      .forEach((node) => {
        const renderData = node.getData(FlowNodeRenderData);

        if (
          node.firstChild &&
          [FlowNodeBaseType.BLOCK_ICON, FlowNodeBaseType.BLOCK_ORDER_ICON].includes(
            node.firstChild.flowNodeType as FlowNodeBaseType
          )
        ) {
          node.collapsed = true;
        }

        renderData.expanded = false;
      });
  },
});

const expand: ShortcutGetter = (ctx) => ({
  commandId: FlowCommandId.EXPAND,
  commandDetail: {
    label: 'Expand',
  },
  shortcuts: ['meta alt closebracket', 'ctrol alt openbracket'],
  isEnabled: () => !ctx.playground.config.readonlyOrDisabled,
  execute: () => {
    const selection = ctx.selection;

    const selectNodes = selection.selection.filter(
      (_entity) => _entity instanceof FlowNodeEntity
    ) as FlowNodeEntity[];

    selectNodes
      .map((_node) => [_node, ..._node.allCollapsedChildren])
      .flat()
      .forEach((node) => {
        const renderData = node.getData(FlowNodeRenderData);

        if (
          node.firstChild &&
          [FlowNodeBaseType.BLOCK_ICON, FlowNodeBaseType.BLOCK_ORDER_ICON].includes(
            node.firstChild.flowNodeType as FlowNodeBaseType
          )
        ) {
          node.collapsed = false;
        }

        renderData.expanded = true;
      });
  },
});

export const shortcutGetter: ShortcutGetter[] = [
  copy,
  cut,
  selectAll,
  cancelSelect,
  zoomIn,
  zoomOut,
  resetZoom,
  group,
  collapse,
  expand,
];
