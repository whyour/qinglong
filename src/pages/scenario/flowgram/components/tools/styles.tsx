import styled from 'styled-components';

export const ToolContainer = styled.div`
  position: absolute;
  bottom: 16px;
  display: flex;
  justify-content: left;
  min-width: 360px;
  pointer-events: none;
  gap: 8px;

  z-index: 20;
`;

export const ToolSection = styled.div`
  display: flex;
  align-items: center;
  background-color: #fff;
  border: 1px solid rgba(68, 83, 130, 0.25);
  border-radius: 10px;
  box-shadow: rgba(0, 0, 0, 0.04) 0px 2px 6px 0px, rgba(0, 0, 0, 0.02) 0px 4px 12px 0px;
  column-gap: 2px;
  height: 40px;
  padding: 0 4px;
  pointer-events: auto;
`;

export const SelectZoom = styled.span`
  padding: 2px;
  border-radius: 8px;
  border: 1px solid rgba(68, 83, 130, 0.25);
  font-size: 12px;
  width: 40px;
`;

export const MinimapContainer = styled.div`
  position: absolute;
  bottom: 60px;
  width: 198px;
`;
