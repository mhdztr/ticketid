import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { initSchema, pool } from '../src/db.js';
import { resetDb } from './setup.js';

describe('WinXP Console UI and concurrency demo endpoint', () => {
  const app = createApp();

  beforeAll(async () => {
    await initSchema();
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('serves static WinXP console assets on /, /xp.css, and /app.js', async () => {
    const htmlRes = await request(app).get('/');
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers['content-type']).toMatch(/text\/html/);
    expect(htmlRes.text).toContain('<title>TicketID</title>');
    expect(htmlRes.text).toContain('Load Test');

    const cssRes = await request(app).get('/xp.css');
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers['content-type']).toMatch(/text\/css/);

    const jsRes = await request(app).get('/app.js');
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers['content-type']).toMatch(/javascript/);
  });

  it('runs 200 concurrent demo reservations via POST /api/payments/concurrency-demo', async () => {
    const res = await request(app).post('/api/payments/concurrency-demo');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total_requests: 200,
      quota: 100,
      created: 100,
      conflicts: 100,
      other: 0,
      remaining_quota: 0,
    });
    expect(res.body.elapsed_ms).toBeTypeOf('number');
  });
});
