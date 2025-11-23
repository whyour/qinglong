import { nanoid } from 'nanoid';
import { FlowNodeBaseType } from '@flowgram.ai/fixed-layout-editor';

import { FlowNodeRegistry } from '../../typings';
import iconEnd from '../../assets/icon-end.jpg';
import { formMeta } from './form-meta';

export const EndNodeRegistry: FlowNodeRegistry = {
  type: 'end',
  meta: {
    isNodeEnd: true, // Mark as end
    selectable: false, // End node cannot select
    copyDisable: true, // End node canot copy
    expandable: false, // disable expanded
  },
  info: {
    icon: iconEnd,
    description:
      'The final node of the workflow, used to return the result information after the workflow is run.',
  },
  /**
   * Render node via formMeta
   */
  formMeta,
  canAdd(ctx, from) {
    // You can only add to the last node of the branch
    if (!from.isLast) return false;
    /**
     * condition
     *  blockIcon
     *  inlineBlocks
     *    block1
     *      blockOrderIcon
     *      <---- [add end]
     *    block2
     *      blockOrderIcon
     *      end
     */
    // originParent can determine whether it is condition , and then determine whether it is the last one
    // https://github.com/bytedance/flowgram.ai/pull/146
    if (
      from.parent &&
      from.parent.parent?.flowNodeType === FlowNodeBaseType.INLINE_BLOCKS &&
      from.parent.originParent &&
      !from.parent.originParent.isLast
    ) {
      const allBranches = from.parent.parent!.blocks;
      // Determine whether the last node of all branch is end, All branches are not allowed to be end
      const branchEndCount = allBranches.filter(
        (block) => block.blocks[block.blocks.length - 1]?.getNodeMeta().isNodeEnd
      ).length;
      return branchEndCount < allBranches.length - 1;
    }
    return true;
  },
  canDelete(ctx, node) {
    return node.parent !== ctx.document.root;
  },
  onAdd(ctx, from) {
    return {
      id: `end_${nanoid()}`,
      type: 'end',
      data: {
        title: 'End',
        outputs: {
          type: 'object',
          properties: {
            result: {
              type: 'string',
            },
          },
        },
      },
    };
  },
};
