import { createApp } from './app.js';
import { config } from './config.js';
import { initSchema, pool } from './db.js';
import { startExpiryWorker } from './workers/expiryWorker.js';

async function initSchemaWithRetry(attempts = 5, delayMs = 1000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await initSchema();
      return;
    } catch (err) {
      if (i === attempts) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function main(): Promise<void> {
  await initSchemaWithRetry();

  const expiryWorker = startExpiryWorker();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`TicketID server listening on port ${config.port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    expiryWorker.stop();
    const forceExit = setTimeout(() => process.exit(1), 5000);
    forceExit.unref();
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
    server.closeIdleConnections();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Failed to start TicketID server:', err);
  process.exit(1);
});
