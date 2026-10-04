import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void => {
  // Never log sensitive authorization headers or secret payloads
  console.error('[API ERROR]', {
    path: req.originalUrl,
    method: req.method,
    name: err?.name,
    code: err?.code,
    message: err?.message,
  });

  // 1. Zod Validation Errors
  if (err instanceof ZodError) {
    const details = err.errors.map((e) => ({
      path: e.path.join('.'),
      message: e.message,
    }));
    res.status(400).json({
      success: false,
      message: 'Validation failed: ' + details.map((d) => `${d.path}: ${d.message}`).join(', '),
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request payload validation failed.',
        details,
      },
    });
    return;
  }

  // 2. Prisma Known Request Errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : 'field';
      res.status(409).json({
        success: false,
        message: `A record with this ${target} already exists.`,
        error: {
          code: 'UNIQUE_CONSTRAINT_VIOLATION',
          message: `A record with this ${target} already exists.`,
        },
      });
      return;
    }

    if (err.code === 'P2025') {
      res.status(404).json({
        success: false,
        message: 'The requested record could not be found.',
        error: {
          code: 'RECORD_NOT_FOUND',
          message: 'The requested record could not be found.',
        },
      });
      return;
    }

    if (err.code === 'P2003') {
      res.status(409).json({
        success: false,
        message: 'Operation cannot be completed because related records depend on this resource.',
        error: {
          code: 'FOREIGN_KEY_VIOLATION',
          message: 'Operation cannot be completed because related records depend on this resource.',
        },
      });
      return;
    }
  }

  // 3. Multer Upload Errors
  if (err.name === 'MulterError') {
    res.status(400).json({
      success: false,
      message: `File upload error: ${err.message}`,
      error: {
        code: 'FILE_UPLOAD_ERROR',
        message: err.message,
      },
    });
    return;
  }

  // 4. Custom Application Errors with explicit status codes
  const statusCode = err.statusCode || (typeof err.status === 'number' ? err.status : 500);
  const errorCode = err.code || (statusCode === 404 ? 'NOT_FOUND' : statusCode === 403 ? 'FORBIDDEN' : statusCode === 401 ? 'UNAUTHORIZED' : 'INTERNAL_SERVER_ERROR');
  
  // Sanitize message: never expose internal database connection strings, passwords, or raw SQL in production
  let publicMessage = err.message || 'An unexpected server error occurred.';
  if (statusCode === 500 && process.env.NODE_ENV === 'production') {
    publicMessage = 'An unexpected internal server error occurred. Please try again later.';
  }

  res.status(statusCode).json({
    success: false,
    message: publicMessage,
    error: {
      code: errorCode,
      message: publicMessage,
    },
  });
};

