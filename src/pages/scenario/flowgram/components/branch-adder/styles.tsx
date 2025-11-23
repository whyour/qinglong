import styled from 'styled-components';

export const Container = styled.div<{ activated?: boolean; isVertical: boolean }>`
  width: 28px;
  height: 18px;
  background: ${(props) => (props.activated ? '#82A7FC' : 'rgb(187, 191, 196)')};
  display: flex;
  border-radius: 9px;
  justify-content: space-evenly;
  align-items: center;
  color: #fff;
  font-size: 10px;
  font-weight: bold;
  transform: ${(props) => (props.isVertical ? '' : 'rotate(90deg)')};
  div {
    display: flex;
    justify-content: center;
    align-items: center;
    svg {
      width: 12px;
      height: 12px;
    }
  }
`;
