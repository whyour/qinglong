import { IGroupNode } from '@flowgram.ai/group-plugin';

import { GroupTools } from './group-tools';
import { GroupNote } from './group-note';

export const GroupNode: IGroupNode = (props: any) => {
  const { groupNode, groupController } = props;

  if (!groupController || !groupController.collapsed) {
    return <></>;
  }

  return (
    <div
      style={{
        border: '1px solid rgb(97, 69, 211)',
        backgroundColor: 'rgb(236 233 247)',
        borderRadius: 10,
        width: 200,
        height: 'auto',
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-around',
        alignItems: 'flex-start',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
        }}
      >
        <div
          style={{
            width: '2rem',
            height: '2rem',
            borderRadius: '1rem',
            background: 'rgb(198 188 241)',
            color: 'rgb(97, 69, 211)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <p style={{ margin: 0 }}>{groupController.nodes.length}</p>
        </div>
        <GroupTools groupNode={groupNode} groupController={groupController} visible={true} />
      </div>
      <GroupNote
        groupNode={groupNode}
        groupController={groupController}
        containerStyle={{
          paddingTop: 10,
          width: '100%',
        }}
      />
    </div>
  );
};
