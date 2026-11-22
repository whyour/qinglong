import { celebrate, Joi } from 'celebrate';
import { Request, Response, NextFunction } from 'express';
import { checkDirectoryVersions, readDirectoryPage } from './directoryPage';

export function directoryCheckHandler(root: () => string, blacklist: string[]) {
  return [
    celebrate({
      body: Joi.array()
        .items(
          Joi.array()
            .ordered(
              Joi.string().allow('').max(4096).required(),
              Joi.string().max(128).allow(null).required(),
            )
            .length(2),
        )
        .min(1)
        .max(128)
        .required(),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const current = await checkDirectoryVersions(
          root(),
          blacklist,
          req.body,
        );
        res.send({ code: 200, current });
      } catch (error) {
        next(error);
      }
    },
  ];
}

export function directoryPageHandler(
  root: () => string,
  blacklist: string[],
  newestFirst: boolean,
) {
  return [
    celebrate({
      query: Joi.object({
        path: Joi.string().allow(''),
        after: Joi.string().allow(''),
        search: Joi.string().allow(''),
        folders: Joi.boolean(),
        t: Joi.string(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { path = '', after = '', search = '', folders } = req.query;
        const page = await readDirectoryPage(
          root(),
          blacklist,
          String(path),
          String(after),
          String(search),
          String(folders) === 'true',
          newestFirst,
        );
        res.send({ code: 200, ...page });
      } catch (error) {
        next(error);
      }
    },
  ];
}
