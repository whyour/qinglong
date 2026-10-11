import styled from 'styled-components';

const primary = 'hsl(252 62% 54.9%)';
const primaryOpacity09 = 'hsl(252deg 62% 55% / 9%)';

export const UIDragNodeContainer = styled.div`
  position: relative;
  height: 32px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  column-gap: 8px;
  cursor: pointer;
  font-size: 19px;
  border: 1px solid ${primary};
  padding: 0 15px;
  &:hover: {
    background-color: ${primaryOpacity09};
    color: ${primary};
  }
`;

export const UIDragCounts = styled.div`
  position: absolute;
  top: -8px;
  right: -8px;
  text-align: center;
  line-height: 16px;
  width: 16px;
  height: 16px;
  border-radius: 8px;
  font-size: 12px;
  color: #fff;
  background-color: ${primary};
`;
