import { ClipboardService } from '@flowgram.ai/fixed-layout-editor';

export const readData = async (clipboard: ClipboardService) => {
  let str: string = '';
  str = (await clipboard.readText()) || '';

  try {
    const data = JSON.parse(str);
    return data;
  } catch (error) {
    return '';
  }
};

export const writeData = async (newData: any, clipboard: ClipboardService) => {
  const data: any = newData;

  const newStrData = JSON.stringify(data);

  const oldSaveData = await navigator.clipboard.readText();

  if (oldSaveData !== newStrData) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(newStrData);
      const event = new Event('onchange');
      (event as unknown as { value: string }).value = newStrData;
      navigator.clipboard.dispatchEvent(event);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = newStrData;

      textarea.style.display = 'absolute';
      textarea.style.left = '-99999999px';

      document.body.prepend(textarea);

      // highlight the content of the textarea element
      textarea.select();

      try {
        document.execCommand('copy');
      } catch (err) {
        console.log(err);
      } finally {
        textarea.remove();
      }
    }

    clipboard.writeText(newStrData);
  }
};
