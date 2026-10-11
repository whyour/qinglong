import { ErrorRequestHandler } from 'express';
import { UniqueConstraintError } from 'sequelize';
import { t } from '../shared/i18n';

// Handle the database constraint itself so concurrent writes are covered too.
const uniqueConstraintError: ErrorRequestHandler = (err, req, res, next) => {
  if (!(err instanceof UniqueConstraintError)) return next(err);
  // Constraint details can contain environment values or application credentials.
  res
    .status(409)
    .json({ code: 409, message: t('资源已存在，请检查重复的名称或值') });
};

export default uniqueConstraintError;
