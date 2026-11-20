import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetClock, setClock } from '../src/clock.js';
import { initSchema, pool } from '../src/db.js';
import { resetDb } from './setup.js';

describe('Ticket orders, buyer limit, and cancellation', () => {
  const app = createApp();

  beforeAll(async () => {
    await initSchema();
  });

  beforeEach(async () => {
    await resetDb();
    resetClock();
  });

  afterAll(async () => {
    resetClock();
    await pool.end();
  });

  async function seedEvent(regulerQuota = 50, vipQuota = 20) {
    const res = await request(app)
      .post('/api/events')
      .send({
        title: 'Tech Summit 2026',
        venue: 'Convention Center',
        event_date: '2026-12-20T10:00:00+07:00',
        ticket_types: [
          { category: 'REGULER', price: 100000, quota: regulerQuota },
          { category: 'VIP', price: 250000, quota: vipQuota },
        ],
      });
    const reguler = res.body.ticket_types.find(
      (t: { category: string }) => t.category === 'REGULER'
    );
    const vip = res.body.ticket_types.find(
      (t: { category: string }) => t.category === 'VIP'
    );
    return { eventId: res.body.id as string, regulerId: reguler.id as string, vipId: vip.id as string };
  }

  it('books tickets with a 15-minute hold and records order history', async () => {
    const { eventId, regulerId } = await seedEvent(10, 5);

    const res = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: regulerId, quantity: 2 });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.order_code).toMatch(/^ORD-[A-Z2-9]{8}$/);
    expect(res.body.unit_price).toBe(100000);
    expect(res.body.total_price).toBe(200000);

    const holdMs =
      new Date(res.body.expires_at).getTime() - new Date(res.body.created_at).getTime();
    expect(holdMs).toBe(15 * 60 * 1000);

    const eventRes = await request(app).get(`/api/events/${eventId}`);
    const reguler = eventRes.body.ticket_types.find(
      (t: { category: string }) => t.category === 'REGULER'
    );
    expect(reguler.available_quota).toBe(8);

    const listRes = await request(app).get('/api/orders').set('X-Buyer-Id', 'buyer-01');
    expect(listRes.status).toBe(200);
    expect(listRes.body.orders).toHaveLength(1);
    expect(listRes.body.orders[0].id).toBe(res.body.id);

    const detailRes = await request(app)
      .get(`/api/orders/${res.body.id}`)
      .set('X-Buyer-Id', 'buyer-01');
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.tickets).toEqual([]);
  });

  it('enforces 4-ticket limit per buyer per event across ticket types', async () => {
    const event1 = await seedEvent(20, 20);
    const event2 = await seedEvent(20, 20);

    const r1 = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: event1.regulerId, quantity: 2 });
    expect(r1.status).toBe(201);

    const r2 = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: event1.vipId, quantity: 2 });
    expect(r2.status).toBe(201);

    const r3 = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: event1.regulerId, quantity: 1 });
    expect(r3.status).toBe(409);
    expect(r3.body.error).toBe('BUYER_LIMIT_EXCEEDED');

    const otherEvent = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: event2.regulerId, quantity: 4 });
    expect(otherEvent.status).toBe(201);
  });

  it('prevents write skew when same buyer books REGULER and VIP simultaneously', async () => {
    const { eventId, regulerId, vipId } = await seedEvent(20, 20);

    const [resA, resB] = await Promise.all([
      request(app)
        .post('/api/orders')
        .set('X-Buyer-Id', 'buyer-race')
        .send({ ticket_type_id: regulerId, quantity: 3 }),
      request(app)
        .post('/api/orders')
        .set('X-Buyer-Id', 'buyer-race')
        .send({ ticket_type_id: vipId, quantity: 3 }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const { rows } = await pool.query<{ active_tickets: number }>(
      'SELECT active_tickets FROM buyer_event_quotas WHERE event_id = $1 AND buyer_id = $2',
      [eventId, 'buyer-race']
    );
    expect(rows[0].active_tickets).toBe(3);
  });

  it('rejects insufficient quota and rolls back buyer allowance cleanly', async () => {
    const { regulerId } = await seedEvent(2, 5);

    const tooMany = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-02')
      .send({ ticket_type_id: regulerId, quantity: 3 });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error).toBe('INSUFFICIENT_QUOTA');

    const remaining = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-02')
      .send({ ticket_type_id: regulerId, quantity: 2 });
    expect(remaining.status).toBe(201);
  });

  it('cancels a pending order and restores quota and buyer allowance', async () => {
    const { eventId, regulerId } = await seedEvent(5, 5);

    const created = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: regulerId, quantity: 4 });
    expect(created.status).toBe(201);

    const cancelled = await request(app)
      .post(`/api/orders/${created.body.id}/cancel`)
      .set('X-Buyer-Id', 'buyer-01');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.cancelled_at).toBeTruthy();

    const eventRes = await request(app).get(`/api/events/${eventId}`);
    const reguler = eventRes.body.ticket_types.find(
      (t: { category: string }) => t.category === 'REGULER'
    );
    expect(reguler.available_quota).toBe(5);

    const rebook = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: regulerId, quantity: 4 });
    expect(rebook.status).toBe(201);
  });

  it('does not inflate quota on concurrent double cancel', async () => {
    const { eventId, regulerId } = await seedEvent(5, 5);

    const created = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: regulerId, quantity: 3 });

    const [c1, c2] = await Promise.all([
      request(app)
        .post(`/api/orders/${created.body.id}/cancel`)
        .set('X-Buyer-Id', 'buyer-01'),
      request(app)
        .post(`/api/orders/${created.body.id}/cancel`)
        .set('X-Buyer-Id', 'buyer-01'),
    ]);

    expect([c1.status, c2.status].sort()).toEqual([200, 409]);

    const eventRes = await request(app).get(`/api/events/${eventId}`);
    const reguler = eventRes.body.ticket_types.find(
      (t: { category: string }) => t.category === 'REGULER'
    );
    expect(reguler.available_quota).toBe(5);
  });

  it('validates headers, quantity bounds, and buyer ownership', async () => {
    const { regulerId } = await seedEvent(10, 10);

    const noBuyer = await request(app)
      .post('/api/orders')
      .send({ ticket_type_id: regulerId, quantity: 1 });
    expect(noBuyer.status).toBe(400);
    expect(noBuyer.body.error).toBe('MISSING_BUYER_ID');

    const badQty = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: regulerId, quantity: 5 });
    expect(badQty.status).toBe(400);

    const created = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: regulerId, quantity: 1 });

    const otherView = await request(app)
      .get(`/api/orders/${created.body.id}`)
      .set('X-Buyer-Id', 'buyer-99');
    expect(otherView.status).toBe(403);

    const otherCancel = await request(app)
      .post(`/api/orders/${created.body.id}/cancel`)
      .set('X-Buyer-Id', 'buyer-99');
    expect(otherCancel.status).toBe(403);
  });

  it('marks order as EXPIRED and restores quota when cancelled past 15 minutes', async () => {
    const baseTime = new Date('2026-11-20T12:00:00.000Z');
    setClock(() => baseTime);

    const { eventId, regulerId } = await seedEvent(10, 5);
    const created = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: regulerId, quantity: 3 });
    expect(created.status).toBe(201);

    setClock(() => new Date(baseTime.getTime() + 15 * 60 * 1000 + 1000));

    const cancelLate = await request(app)
      .post(`/api/orders/${created.body.id}/cancel`)
      .set('X-Buyer-Id', 'buyer-01');
    expect(cancelLate.status).toBe(409);
    expect(cancelLate.body.error).toBe('ORDER_EXPIRED');

    const orderRes = await request(app)
      .get(`/api/orders/${created.body.id}`)
      .set('X-Buyer-Id', 'buyer-01');
    expect(orderRes.body.status).toBe('EXPIRED');

    const eventRes = await request(app).get(`/api/events/${eventId}`);
    const reguler = eventRes.body.ticket_types.find(
      (t: { category: string }) => t.category === 'REGULER'
    );
    expect(reguler.available_quota).toBe(10);
  });
});
