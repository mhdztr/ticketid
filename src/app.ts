import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request } from 'express';
import { checkDb } from './db.js';
import { errorHandler } from './errors.js';
import { eventsRouter } from './routes/events.js';
import { ordersRouter } from './routes/orders.js';
import { paymentsRouter, webhooksRouter } from './routes/payments.js';
import { ticketsRouter } from './routes/tickets.js';

export type RawBodyRequest = Request & { rawBody?: Buffer };

export function createApp() {
  const app = express();

  // Keep raw payload bytes so payment webhooks can verify exact HMAC signatures
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf;
      },
    })
  );

  app.get('/healthz', async (_req, res) => {
    const dbUp = await checkDb();
    if (!dbUp) {
      res.status(503).json({ status: 'error', db: 'down' });
      return;
    }
    res.json({ status: 'ok', db: 'up' });
  });

  const publicDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../public'
  );
  app.use(express.static(publicDir));

  app.use('/api/events', eventsRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/tickets', ticketsRouter);
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/payments', paymentsRouter);

  app.use((_req, res) => {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: 'Route not found',
    });
  });

  app.use(errorHandler);

  return app;
}
