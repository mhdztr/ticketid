import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5433/ticketid',
  orderTtlSeconds: Number(process.env.ORDER_TTL_SECONDS ?? 900),
  expirySweepIntervalMs: Number(process.env.EXPIRY_SWEEP_INTERVAL_MS ?? 3000),
  webhookSecret: process.env.WEBHOOK_SECRET ?? 'dev-webhook-secret-change-me',
};
