import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { initSchema, pool } from '../src/db.js';
import { resetDb } from './setup.js';

describe('Events and ticket quotas', () => {
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

  const samplePayload = {
    title: 'Indie Music Night',
    description: 'Intimate acoustic showcase',
    venue: 'Hall A Jakarta',
    event_date: '2026-12-10T19:00:00+07:00',
    ticket_types: [
      { category: 'VIP', price: 350000, quota: 25 },
      { category: 'REGULER', price: 150000, quota: 75 },
    ],
  };

  it('creates an event with REGULER and VIP quotas', async () => {
    const res = await request(app).post('/api/events').send(samplePayload);

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Indie Music Night');
    expect(res.body.max_tickets_per_buyer).toBe(4);
    expect(res.body.ticket_types).toHaveLength(2);
    expect(res.body.ticket_types[0]).toMatchObject({
      category: 'REGULER',
      price: 150000,
      total_quota: 75,
      available_quota: 75,
    });
    expect(res.body.ticket_types[1]).toMatchObject({
      category: 'VIP',
      price: 350000,
      total_quota: 25,
      available_quota: 25,
    });
  });

  it('lists events and gets a single event with remaining quota', async () => {
    const created = await request(app).post('/api/events').send(samplePayload);
    const eventId = created.body.id;

    const listRes = await request(app).get('/api/events');
    expect(listRes.status).toBe(200);
    expect(listRes.body.events).toHaveLength(1);
    expect(listRes.body.events[0].id).toBe(eventId);
    expect(listRes.body.events[0].ticket_types).toHaveLength(2);

    const detailRes = await request(app).get(`/api/events/${eventId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.id).toBe(eventId);
    expect(detailRes.body.ticket_types[0].available_quota).toBe(75);
    expect(detailRes.body.ticket_types[1].available_quota).toBe(25);
  });

  it('rejects invalid event payloads and malformed ids', async () => {
    const missingVip = await request(app)
      .post('/api/events')
      .send({
        ...samplePayload,
        ticket_types: [{ category: 'REGULER', price: 100000, quota: 50 }],
      });
    expect(missingVip.status).toBe(400);
    expect(missingVip.body.error).toBe('VALIDATION_ERROR');

    const duplicateCat = await request(app)
      .post('/api/events')
      .send({
        ...samplePayload,
        ticket_types: [
          { category: 'REGULER', price: 100000, quota: 50 },
          { category: 'REGULER', price: 200000, quota: 50 },
        ],
      });
    expect(duplicateCat.status).toBe(400);

    const zeroQuota = await request(app)
      .post('/api/events')
      .send({
        ...samplePayload,
        ticket_types: [
          { category: 'REGULER', price: 100000, quota: 0 },
          { category: 'VIP', price: 200000, quota: 20 },
        ],
      });
    expect(zeroQuota.status).toBe(400);

    const badId = await request(app).get('/api/events/not-a-uuid');
    expect(badId.status).toBe(400);
  });

  it('returns 404 when event id does not exist', async () => {
    const res = await request(app).get(
      '/api/events/00000000-0000-4000-8000-000000000000'
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('EVENT_NOT_FOUND');
  });
});
