const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { Container } = require('typedi');

test('initialization returns the username and password validation result', async (t) => {
  const originalGet = Container.get;
  const userServicePath = require.resolve('../../back/services/user');
  const originalUserService = require.cache[userServicePath];
  const i18nPath = require.resolve('../../back/shared/i18n');
  const originalI18n = require.cache[i18nPath];
  const utilPath = require.resolve('../../back/config/util');
  const originalUtil = require.cache[utilPath];
  const authPath = require.resolve('../../back/shared/auth');
  const originalAuth = require.cache[authPath];
  require.cache[userServicePath] = {
    id: userServicePath,
    filename: userServicePath,
    loaded: true,
    exports: { __esModule: true, default: class UserService {} },
    children: [],
    paths: [],
  };
  require.cache[utilPath] = {
    id: utilPath,
    filename: utilPath,
    loaded: true,
    exports: { getToken: () => '', isDemoEnv: () => false },
    children: [],
    paths: [],
  };
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: { isDefaultAuthInfo: () => false },
    children: [],
    paths: [],
  };
  require.cache[i18nPath] = {
    id: i18nPath,
    filename: i18nPath,
    loaded: true,
    exports: { t: (message) => message },
    children: [],
    paths: [],
  };
  Container.get = () => ({
    initializeUser: async () => ({
      code: 400,
      message: 'password rejected',
    }),
  });
  t.after(() => {
    Container.get = originalGet;
    if (originalUserService) {
      require.cache[userServicePath] = originalUserService;
    } else {
      delete require.cache[userServicePath];
    }
    if (originalI18n) {
      require.cache[i18nPath] = originalI18n;
    } else {
      delete require.cache[i18nPath];
    }
    if (originalUtil) {
      require.cache[utilPath] = originalUtil;
    } else {
      delete require.cache[utilPath];
    }
    if (originalAuth) {
      require.cache[authPath] = originalAuth;
    } else {
      delete require.cache[authPath];
    }
  });

  const app = express.Router();
  require('../../back/api/user').default(app);
  const userRouter = app.stack.find((layer) => layer.name === 'router').handle;
  const initRoute = userRouter.stack.find(
    (layer) => layer.route?.path === '/init',
  );
  const handler = initRoute.route.stack.at(-1).handle;
  let responseBody;

  await handler(
    { body: { username: 'admin', password: 'admin' } },
    { send: (body) => (responseBody = body) },
    (error) => {
      throw error;
    },
  );

  assert.deepEqual(responseBody, {
    code: 400,
    message: 'password rejected',
  });
});
