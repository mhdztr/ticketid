import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.code,
      message: err.message,
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Invalid request payload',
      issues: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
    res.status(400).json({
      error: 'INVALID_JSON',
      message: 'Malformed JSON request body',
    });
    return;
  }

  console.error(err);
  const message =
    process.env.NODE_ENV === 'development' && err instanceof Error
      ? err.message
      : 'Internal server error';

  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message,
  });
}
