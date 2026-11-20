import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { initSchema, pool } from '../src/db.js';

describe('Health and database schema', () => {
  const app = createApp();

  beforeAll(async () => {
    await initSchema();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('returns 200 ok on GET /healthz', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });

  it('creates all required core tables', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_name`
    );

    const names = rows.map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'buyer_event_quotas',
        'events',
        'orders',
        'payment_webhooks',
        'ticket_types',
        'tickets',
      ])
    );
  });
});
