import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetClock, setClock } from '../src/clock.js';
import { initSchema, pool } from '../src/db.js';
import { expirePendingOrders } from '../src/services/orderService.js';
import { startExpiryWorker } from '../src/workers/expiryWorker.js';
import { resetDb } from './setup.js';

describe('Order expiry worker and lazy expiry guard', () => {
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

  async function seedEvent(regulerQuota = 10, vipQuota = 10) {
    const res = await request(app)
      .post('/api/events')
      .send({
        title: 'Expiry Test Concert',
        venue: 'Studio B',
        event_date: '2026-12-25T19:00:00+07:00',
        ticket_types: [
          { category: 'REGULER', price: 100000, quota: regulerQuota },
          { category: 'VIP', price: 250000, quota: vipQuota },
        ],
      });
    const reguler = res.body.ticket_types.find(
      (t: { category: string }) => t.category === 'REGULER'
    );
    return {
      eventId: res.body.id as string,
      regulerId: reguler.id as string,
    };
  }

  it('keeps orders pending before 15 minutes pass', async () => {
    const baseTime = new Date('2026-11-20T10:00:00.000Z');
    setClock(() => baseTime);

    const { eventId, regulerId } = await seedEvent(5, 5);
    const created = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: regulerId, quantity: 2 });
    expect(created.status).toBe(201);

    setClock(() => new Date(baseTime.getTime() + 14 * 60 * 1000 + 59 * 1000));
    const swept = await expirePendingOrders();
    expect(swept).toBe(0);

    const eventRes = await request(app).get(`/api/events/${eventId}`);
    const reguler = eventRes.body.ticket_types.find(
      (t: { category: string }) => t.category === 'REGULER'
    );
    expect(reguler.available_quota).toBe(3);
  });

  it('expires overdue orders via background worker and releases quota', async () => {
    const baseTime = new Date('2026-11-20T10:00:00.000Z');
    setClock(() => baseTime);

    const { eventId, regulerId } = await seedEvent(5, 5);
    const created = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: regulerId, quantity: 3 });

    setClock(() => new Date(baseTime.getTime() + 15 * 60 * 1000 + 100));

    const worker = startExpiryWorker(25);
    try {
      for (let i = 0; i < 20; i++) {
        const check = await pool.query<{ status: string }>(
          'SELECT status FROM orders WHERE id = $1',
          [created.body.id]
        );
        if (check.rows[0].status === 'EXPIRED') {
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      worker.stop();
    }

    const orderRow = await pool.query<{ status: string; expired_at: Date | null }>(
      'SELECT status, expired_at FROM orders WHERE id = $1',
      [created.body.id]
    );
    expect(orderRow.rows[0].status).toBe('EXPIRED');
    expect(orderRow.rows[0].expired_at).not.toBeNull();

    const eventRes = await request(app).get(`/api/events/${eventId}`);
    const reguler = eventRes.body.ticket_types.find(
      (t: { category: string }) => t.category === 'REGULER'
    );
    expect(reguler.available_quota).toBe(5);

    const quotaRow = await pool.query<{ active_tickets: number }>(
      'SELECT active_tickets FROM buyer_event_quotas WHERE event_id = $1 AND buyer_id = $2',
      [eventId, 'buyer-01']
    );
    expect(quotaRow.rows[0].active_tickets).toBe(0);
  });

  it('handles parallel sweepers safely without double releasing quota', async () => {
    const baseTime = new Date('2026-11-20T10:00:00.000Z');
    setClock(() => baseTime);

    const { eventId, regulerId } = await seedEvent(10, 5);

    for (let i = 1; i <= 5; i++) {
      const res = await request(app)
        .post('/api/orders')
        .set('X-Buyer-Id', `buyer-0${i}`)
        .send({ ticket_type_id: regulerId, quantity: 2 });
      expect(res.status).toBe(201);
    }

    setClock(() => new Date(baseTime.getTime() + 15 * 60 * 1000 + 1000));

    const results = await Promise.all([
      expirePendingOrders(),
      expirePendingOrders(),
      expirePendingOrders(),
      expirePendingOrders(),
      expirePendingOrders(),
    ]);

    const totalSwept = results.reduce((sum, n) => sum + n, 0);
    expect(totalSwept).toBe(5);

    const ttRow = await pool.query<{ available_quota: number; total_quota: number }>(
      'SELECT available_quota, total_quota FROM ticket_types WHERE id = $1',
      [regulerId]
    );
    expect(ttRow.rows[0].available_quota).toBe(ttRow.rows[0].total_quota);

    const quotaRows = await pool.query<{ active_tickets: number }>(
      'SELECT active_tickets FROM buyer_event_quotas WHERE event_id = $1',
      [eventId]
    );
    expect(quotaRows.rows.every((r) => r.active_tickets === 0)).toBe(true);
  });

  it('performs lazy expiry on reads and retries blocked bookings immediately', async () => {
    const baseTime = new Date('2026-11-20T10:00:00.000Z');
    setClock(() => baseTime);

    const { eventId: ev1Id, regulerId: ev1Reguler } = await seedEvent(2, 5);
    await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: ev1Reguler, quantity: 2 });

    setClock(() => new Date(baseTime.getTime() + 16 * 60 * 1000));

    const eventRes = await request(app).get(`/api/events/${ev1Id}`);
    const ev1Type = eventRes.body.ticket_types.find(
      (t: { category: string }) => t.category === 'REGULER'
    );
    expect(ev1Type.available_quota).toBe(2);

    const ordersRes = await request(app)
      .get('/api/orders')
      .set('X-Buyer-Id', 'buyer-01');
    expect(ordersRes.body.orders[0].status).toBe('EXPIRED');

    setClock(() => baseTime);
    const { regulerId: ev2Reguler } = await seedEvent(2, 5);
    await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: ev2Reguler, quantity: 2 });

    setClock(() => new Date(baseTime.getTime() + 16 * 60 * 1000));
    const takeOver = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-02')
      .send({ ticket_type_id: ev2Reguler, quantity: 2 });
    expect(takeOver.status).toBe(201);

    setClock(() => baseTime);
    const { regulerId: ev3Reguler } = await seedEvent(10, 5);
    await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: ev3Reguler, quantity: 4 });

    setClock(() => new Date(baseTime.getTime() + 16 * 60 * 1000));
    const rebook = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: ev3Reguler, quantity: 4 });
    expect(rebook.status).toBe(201);
  });

  it('never expires paid orders even after expires_at passes', async () => {
    const baseTime = new Date('2026-11-20T10:00:00.000Z');
    setClock(() => baseTime);

    const { regulerId } = await seedEvent(5, 5);
    const created = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-01')
      .send({ ticket_type_id: regulerId, quantity: 2 });

    await pool.query(
      `UPDATE orders SET status = 'PAID', paid_at = $2 WHERE id = $1`,
      [created.body.id, baseTime]
    );

    setClock(() => new Date(baseTime.getTime() + 20 * 60 * 1000));
    const swept = await expirePendingOrders();
    expect(swept).toBe(0);

    const check = await pool.query<{ status: string }>(
      'SELECT status FROM orders WHERE id = $1',
      [created.body.id]
    );
    expect(check.rows[0].status).toBe('PAID');
  });
});
