import { createApp } from './app.js';
import { config } from './config.js';
import { initSchema, pool } from './db.js';

async function main(): Promise<void> {
  await initSchema();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`TicketID server listening on port ${config.port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Failed to start TicketID server:', err);
  process.exit(1);
});
