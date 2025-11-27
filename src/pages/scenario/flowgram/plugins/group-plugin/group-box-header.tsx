import { type CSSProperties } from 'react';

import { IGroupBoxHeader } from '@flowgram.ai/group-plugin';

import { GroupTools } from './group-tools';
import { GroupNote } from './group-note';

export const GroupBoxHeader: IGroupBoxHeader = (props: any) => {
  const { groupNode, groupController } = props;

  if (!groupController || groupController.collapsed) {
    return <></>;
  }

  const basicStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: 10,
    zIndex: 10,
  };

  return (
    <div className="gedit-group-container" style={basicStyle}>
      <GroupNote
        containerStyle={{
          width: '48%',
          transform: 'translateY(-6px)',
        }}
        textStyle={{
          wordBreak: 'break-all',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          height: groupController.positionConfig.headerHeight,
        }}
        groupNode={groupNode}
        groupController={groupController}
      />
      <GroupTools
        groupNode={groupNode}
        groupController={groupController}
        visible={groupController.hovered}
      />
    </div>
  );
};
