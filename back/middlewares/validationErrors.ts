import { errors, isCelebrateError } from 'celebrate';
import { ErrorRequestHandler } from 'express';
import { t } from '../shared/i18n';

const respond = errors();

// Schemas are compiled once at startup; resolve their messages per request so
// changing the system language also changes errors from those existing schemas.
const validationErrors: ErrorRequestHandler = (error, req, res, next) => {
  if (isCelebrateError(error)) {
    for (const detail of error.details.values()) {
      detail.message = detail.details.map((item) => t(item.message)).join('. ');
    }
  }
  return respond(error, req, res, next);
};

export default validationErrors;
