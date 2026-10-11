import styled from 'styled-components';

export const FormWrapper = styled.div`
  box-sizing: border-box;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background-color: rgb(251, 251, 251);
  border-radius: 0 0 8px 8px;
  padding: 0 12px 12px;
`;

export const FormTitleDescription = styled.div`
  color: var(--semi-color-text-2);
  font-size: 12px;
  line-height: 20px;
  padding: 0px 4px;
  word-break: break-all;
  white-space: break-spaces;
`;
