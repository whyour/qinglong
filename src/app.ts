const baseUrl = window.__ENV__QlBaseUrl || '/';

export function modifyClientRenderOpts(memo: any) {
  return {
    ...memo,
    publicPath: baseUrl,
    basename: baseUrl,
  };
}

export function modifyContextOpts(memo: any) {
  return {
    ...memo,
    basename: baseUrl,
  };
}
