import { useState, useEffect } from 'react';
import browserType from './browser';

export const useCtx = () => {
  const [width, setWidth] = useState('100%');
  const [marginLeft, setMarginLeft] = useState(0);
  const [marginTop, setMarginTop] = useState(-72);
  const [isPhone, setIsPhone] = useState(false);

  useEffect(() => {
    const { platform } = browserType();

    if (platform === 'mobile') {
      setWidth('auto');
      setMarginLeft(0);
      setMarginTop(0);
      setIsPhone(true);
    } else {
      setWidth('100%');
      setMarginLeft(0);
      setMarginTop(-72);
      setIsPhone(false);
    }
  }, []);

  return {
    headerStyle: {
      padding: '4px 16px 4px 15px',
      position: 'sticky',
      top: 0,
      left: 0,
      zIndex: 20,
      marginTop,
      width,
      marginLeft,
    } as any,
    isPhone,
  };
};

export const useTheme = () => {
  const [theme, setTheme] = useState<string>('');

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const storageTheme = localStorage.getItem('qinglong_dark_theme');
    const isDark =
      (media.matches && storageTheme !== 'light') || storageTheme === 'dark';
    setTheme(isDark ? 'vs-dark' : 'vs');
    media.addEventListener('change', (e) => {
      if (storageTheme === 'auto' || !storageTheme) {
        if (e.matches) {
          setTheme('vs-dark');
        } else {
          setTheme('vs');
        }
      }
    });
  }, []);

  return { theme };
};
