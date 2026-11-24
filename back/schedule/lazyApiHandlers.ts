import type {
  UntypedServiceImplementation,
  sendUnaryData,
} from '@grpc/grpc-js';
import { ApiService } from '../protos/api';

// Registration/health never need the script API's HTTP-oriented services.
// Keep their dependency graph out of an ordinary scheduler's resident heap.
// Dynamic import shares initialization across simultaneous first calls; the
// normal handlers retain validation, callback errors and service singletons.
export function lazyApiHandlers(): UntypedServiceImplementation {
  return Object.fromEntries(
    Object.keys(ApiService).map((method) => [
      method,
      (call: unknown, callback: sendUnaryData<unknown>) => {
        void import('./api')
          .then((handlers) => {
            const handler = handlers[method as keyof typeof ApiService];
            return handler(call as never, callback);
          })
          .catch(callback);
      },
    ]),
  );
}
