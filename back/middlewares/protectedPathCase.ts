import type { NextFunction, Request, Response } from 'express';

export default function protectedPathCase(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const originalPath = req.path;
  const normalizedPath = originalPath.toLowerCase();

  if (
    originalPath !== normalizedPath &&
    (normalizedPath.startsWith('/api/') ||
      normalizedPath.startsWith('/open/'))
  ) {
    return res.status(400).json({
      code: 400,
      message: 'Invalid path format',
    });
  }

  return next();
}
