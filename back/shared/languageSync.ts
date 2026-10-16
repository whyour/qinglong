import cluster from 'cluster';
import { setLang, systemLang } from './i18n';

function languageMessage(
  message: unknown,
): message is { type: string; lang: string } {
  const value = message as { type?: string; lang?: string } | null;
  return (
    value?.type === 'language-changed' && ['zh', 'en'].includes(value.lang!)
  );
}

// Each worker owns a translation cache. Relay saved settings to live workers;
// a replacement worker restores the persisted language before serving requests.
export async function initializeLanguageSync() {
  if (cluster.isPrimary) {
    cluster.on('message', (_worker, message) => {
      if (!languageMessage(message)) return;
      setLang(message.lang, false);
      for (const worker of Object.values(cluster.workers || {})) {
        if (worker?.isConnected()) worker.send(message, () => {});
      }
    });
    return;
  } else {
    process.on('message', (message) => {
      if (languageMessage(message)) setLang(message.lang, false);
    });
  }
  const { shareStore } = await import('./store');
  setLang((await shareStore.getLang()) || systemLang(), false);
}
