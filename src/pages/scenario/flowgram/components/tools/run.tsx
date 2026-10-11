import { useState } from 'react';

import {
  usePlayground,
  FlowNodeEntity,
  FixedLayoutPluginContext,
  useClientContext,
  delay,
} from '@flowgram.ai/fixed-layout-editor';
import { Button } from 'antd';

const styleElement = document.createElement('style');
const RUNNING_COLOR = 'rgb(78, 64, 229)';
const RUNNING_INTERVAL = 1000;

function getRunningNodes(targetNode?: FlowNodeEntity | undefined, addChildren?: boolean): string[] {
  const result: string[] = [];
  if (targetNode) {
    result.push(targetNode.id);
    if (addChildren) {
      result.push(...targetNode.allChildren.map((n) => n.id));
    }
    if (targetNode.parent) {
      result.push(targetNode.parent.id);
    }
    if (targetNode.pre) {
      result.push(...getRunningNodes(targetNode.pre, true));
    }
    if (targetNode.parent) {
      if (targetNode.parent.pre) {
        result.push(...getRunningNodes(targetNode.parent.pre, true));
      }
    }
  }
  return result;
}

function clear() {
  styleElement.innerText = '';
}

function runningNode(ctx: FixedLayoutPluginContext, nodeId: string) {
  const nodes = getRunningNodes(ctx.document.getNode(nodeId), true);
  if (nodes.length === 0) {
    styleElement.innerText = '';
  } else {
    const content = nodes
      .map(
        (n) => `
      path[data-line-id$="${n}"] {
        animation: flowingDash 0.5s linear infinite;
        stroke-dasharray: 8, 5;
        stroke: ${RUNNING_COLOR} !important;
      }
      marker[data-line-id$="${n}"] path {
        fill: ${RUNNING_COLOR} !important;
      }
      [data-node-id$="${n}"] {
        border: 1px dashed ${RUNNING_COLOR} !important;
        border-radius: 8px;
      }
      [data-label-id$="${n}"] {
        color: ${RUNNING_COLOR} !important;
      }
    `
      )
      .join('\n');
    styleElement.innerText = `
   @keyframes flowingDash {
    to {
      stroke-dashoffset: -13;
    }
  }
  ${content}
  `;
  }
  if (!styleElement.parentNode) {
    document.body.appendChild(styleElement);
  }
}

/**
 * Run the simulation and highlight the lines
 */
export function Run() {
  const [isRunning, setRunning] = useState(false);
  const ctx = useClientContext();
  const playground = usePlayground();
  const onRun = async () => {
    setRunning(true);
    playground.config.readonly = true;
    const nodes = ctx.document.root.blocks.slice();
    while (nodes.length > 0) {
      const currentNode = nodes.shift();
      runningNode(ctx, currentNode!.id);
      await delay(RUNNING_INTERVAL);
    }

    playground.config.readonly = false;
    clear();
    setRunning(false);
  };
  return (
    <Button onClick={onRun} loading={isRunning}>
      Run
    </Button>
  );
}
