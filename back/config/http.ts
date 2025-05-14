import { request as undiciRequest, Dispatcher } from 'undici';

type RequestBaseOptions = {
  dispatcher?: Dispatcher;
  json?: Record<string, any>;
  form?: string;
  headers?: Record<string, string>;
} & Omit<Dispatcher.RequestOptions<null>, 'origin' | 'path' | 'method'>;

type RequestOptionsWithOptions = RequestBaseOptions &
  Partial<Pick<Dispatcher.RequestOptions, 'method'>>;

type ResponseTypeMap = {
  json: Record<string, any>;
  text: string;
};

type ResponseTypeKey = keyof ResponseTypeMap;

async function request(
  url: string,
  options?: RequestOptionsWithOptions,
): Promise<Dispatcher.ResponseData<null>> {
  const { json, form, body, headers = {}, ...rest } = options || {};
  const finalHeaders = { ...headers } as Record<string, string>;
  let finalBody = body;

  if (json) {
    finalHeaders['content-type'] = 'application/json';
    finalBody = JSON.stringify(json);
  } else if (form) {
    finalBody = form;
    delete finalHeaders['content-type'];
  }

  const res = await undiciRequest(url, {
    method: 'POST',
    headers: finalHeaders,
    body: finalBody,
    ...rest,
  });

  return res;
}

async function post<T extends ResponseTypeKey = 'json'>(
  url: string,
  options?: RequestBaseOptions & { responseType?: T },
): Promise<ResponseTypeMap[T]> {
  const resp = await request(url, { ...options, method: 'POST' });

  const rawText = await resp.body.text();

  if (options?.responseType === 'text') {
    return rawText as ResponseTypeMap[T];
  }

  try {
    return JSON.parse(rawText) as ResponseTypeMap[T];
  } catch {
    return rawText as ResponseTypeMap[T];
  }
}

export const httpClient = {
  post,
  request,
};
