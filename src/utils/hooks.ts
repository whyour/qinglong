import { useState, useEffect } from 'react';

export const useCtx = () => {
  // Match ProLayout's xs/sm breakpoint, including narrow desktop windows.
  const [isPhone, setIsPhone] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 767.99px)').matches,
  );

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767.99px)');
    const update = () => {
      setIsPhone(media.matches);
      document.body.setAttribute(
        'data-mode',
        media.matches ? 'phone' : 'desktop',
      );
    };
    update();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  return {
    headerStyle: {
      padding: '4px 16px 4px 15px',
      position: 'sticky',
      top: 0,
      left: 0,
      zIndex: 20,
      marginTop: isPhone ? 0 : -48,
      width: isPhone ? 'auto' : '100%',
      marginLeft: 0,
    } as any,
    isPhone,
  };
};

export const useTheme = () => {
  const [theme, setTheme] = useState<'vs' | 'vs-dark'>();

  const reloadTheme = () => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const storageTheme = localStorage.getItem('qinglong_dark_theme');
    const isDark =
      (media.matches && storageTheme !== 'light') || storageTheme === 'dark';
    setTheme(isDark ? 'vs-dark' : 'vs');
  };

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const storageTheme = localStorage.getItem('qinglong_dark_theme');
    const isDark =
      (media.matches && storageTheme !== 'light') || storageTheme === 'dark';
    setTheme(isDark ? 'vs-dark' : 'vs');

    const cb = (e: any) => {
      if (storageTheme === 'auto' || !storageTheme) {
        if (e.matches) {
          setTheme('vs-dark');
        } else {
          setTheme('vs');
        }
      }
    };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', cb);
    } else if (typeof media.addListener === 'function') {
      media.addListener(cb);
    }
  }, []);

  return { theme, reloadTheme };
};
