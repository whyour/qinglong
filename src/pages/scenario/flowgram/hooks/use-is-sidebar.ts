import { useContext } from 'react';

import { IsSidebarContext } from '../context';

export function useIsSidebar() {
  return useContext(IsSidebarContext);
}
