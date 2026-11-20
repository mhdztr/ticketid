import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetClock, setClock } from '../src/clock.js';
import { initSchema, pool } from '../src/db.js';
import { signWebhookPayload } from '../src/services/paymentService.js';
import { resetDb } from './setup.js';

describe('Payment webhook idempotency, late payments, and ticket issuance', () => {
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

  async function seedEventAndOrder(quota = 10, qty = 3, buyerId = 'buyer-01') {
    const ev = await request(app)
      .post('/api/events')
      .send({
        title: 'Acoustic Fest',
        venue: 'Hall C',
        event_date: '2026-12-30T20:00:00+07:00',
        ticket_types: [
          { category: 'REGULER', price: 120000, quota },
          { category: 'VIP', price: 300000, quota: 5 },
        ],
      });
    const reguler = ev.body.ticket_types.find(
      (t: { category: string }) => t.category === 'REGULER'
    );
    const order = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', buyerId)
      .send({ ticket_type_id: reguler.id, quantity: qty });

    return {
      eventId: ev.body.id as string,
      regulerId: reguler.id as string,
      orderId: order.body.id as string,
    };
  }

  function postSignedWebhook(payload: {
    webhook_id: string;
    order_id: string;
    status: 'PAID' | 'FAILED';
  }) {
    const raw = JSON.stringify(payload);
    const signature = signWebhookPayload(raw);
    return request(app)
      .post('/api/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', `sha256=${signature}`)
      .send(raw);
  }

  it('verifies HMAC signature, marks order PAID, and issues unique tickets', async () => {
    const { orderId } = await seedEventAndOrder(10, 3, 'buyer-01');

    const res = await postSignedWebhook({
      webhook_id: 'wh-ok-1',
      order_id: orderId,
      status: 'PAID',
    });

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('PAID');
    expect(res.body.resolution).toBe('PAID_ISSUED');
    expect(res.body.idempotent_replay).toBe(false);
    expect(res.body.refund_required).toBe(false);
    expect(res.body.tickets).toHaveLength(3);

    const codes = new Set(
      res.body.tickets.map((t: { ticket_code: string }) => t.ticket_code)
    );
    expect(codes.size).toBe(3);
    for (const ticket of res.body.tickets) {
      expect(ticket.ticket_code).toMatch(/^TKT-[A-Z2-9]{10}$/);
    }

    const orderRes = await request(app)
      .get(`/api/orders/${orderId}`)
      .set('X-Buyer-Id', 'buyer-01');
    expect(orderRes.body.status).toBe('PAID');
    expect(orderRes.body.tickets).toHaveLength(3);

    const ticketsRes = await request(app)
      .get('/api/tickets')
      .set('X-Buyer-Id', 'buyer-01');
    expect(ticketsRes.status).toBe(200);
    expect(ticketsRes.body.tickets).toHaveLength(3);
    expect(ticketsRes.body.tickets[0].event_title).toBe('Acoustic Fest');
  });

  it('rejects missing or invalid webhook signature with 401', async () => {
    const { orderId } = await seedEventAndOrder(10, 2, 'buyer-01');

    const missingSig = await request(app)
      .post('/api/webhooks/payments')
      .send({ webhook_id: 'wh-nosig', order_id: orderId, status: 'PAID' });
    expect(missingSig.status).toBe(401);
    expect(missingSig.body.error).toBe('INVALID_SIGNATURE');

    const badSig = await request(app)
      .post('/api/webhooks/payments')
      .set('X-Webhook-Signature', 'deadbeef'.repeat(8))
      .send({ webhook_id: 'wh-badsig', order_id: orderId, status: 'PAID' });
    expect(badSig.status).toBe(401);

    const ticketCount = await pool.query<{ count: string }>(
      'SELECT COUNT(*) FROM tickets WHERE order_id = $1',
      [orderId]
    );
    expect(Number(ticketCount.rows[0].count)).toBe(0);
  });

  it('handles 5 concurrent duplicate webhooks idempotently without issuing extra tickets', async () => {
    const { orderId } = await seedEventAndOrder(10, 3, 'buyer-01');

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        postSignedWebhook({
          webhook_id: 'wh-race-dup',
          order_id: orderId,
          status: 'PAID',
        })
      )
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    const firstRuns = results.filter((r) => !r.body.idempotent_replay);
    const replays = results.filter((r) => r.body.idempotent_replay);
    expect(firstRuns).toHaveLength(1);
    expect(replays).toHaveLength(4);

    const ticketCount = await pool.query<{ count: string }>(
      'SELECT COUNT(*) FROM tickets WHERE order_id = $1',
      [orderId]
    );
    expect(Number(ticketCount.rows[0].count)).toBe(3);
  });

  it('ignores a second webhook with a different webhook_id for an already PAID order', async () => {
    const { orderId } = await seedEventAndOrder(10, 2, 'buyer-01');

    const first = await postSignedWebhook({
      webhook_id: 'wh-first',
      order_id: orderId,
      status: 'PAID',
    });
    expect(first.body.resolution).toBe('PAID_ISSUED');

    const second = await postSignedWebhook({
      webhook_id: 'wh-second-id',
      order_id: orderId,
      status: 'PAID',
    });
    expect(second.status).toBe(200);
    expect(second.body.resolution).toBe('DUPLICATE_IGNORED');
    expect(second.body.idempotent_replay).toBe(true);
    expect(second.body.tickets).toHaveLength(2);

    const ticketCount = await pool.query<{ count: string }>(
      'SELECT COUNT(*) FROM tickets WHERE order_id = $1',
      [orderId]
    );
    expect(Number(ticketCount.rows[0].count)).toBe(2);
  });

  it('flags late webhook after 15m expiry for refund without overselling', async () => {
    const baseTime = new Date('2026-11-20T12:00:00.000Z');
    setClock(() => baseTime);

    const { eventId, orderId } = await seedEventAndOrder(2, 2, 'buyer-01');
    setClock(() => new Date(baseTime.getTime() + 16 * 60 * 1000));

    const lateRes = await postSignedWebhook({
      webhook_id: 'wh-late-1',
      order_id: orderId,
      status: 'PAID',
    });

    expect(lateRes.status).toBe(200);
    expect(lateRes.body.order_status).toBe('EXPIRED');
    expect(lateRes.body.resolution).toBe('LATE_EXPIRED_NEEDS_REFUND');
    expect(lateRes.body.refund_required).toBe(true);
    expect(lateRes.body.tickets).toEqual([]);

    const eventRes = await request(app).get(`/api/events/${eventId}`);
    const reguler = eventRes.body.ticket_types.find(
      (t: { category: string }) => t.category === 'REGULER'
    );
    expect(reguler.available_quota).toBe(2);
  });

  it('prevents oversell when late webhook hits after quota was sold to another buyer or order was cancelled', async () => {
    const baseTime = new Date('2026-11-20T12:00:00.000Z');
    setClock(() => baseTime);

    const { regulerId, orderId: expiredOrderId } = await seedEventAndOrder(
      2,
      2,
      'buyer-01'
    );
    setClock(() => new Date(baseTime.getTime() + 16 * 60 * 1000));

    const takeOver = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-02')
      .send({ ticket_type_id: regulerId, quantity: 2 });
    expect(takeOver.status).toBe(201);

    const lateAfterSoldOut = await postSignedWebhook({
      webhook_id: 'wh-late-after-soldout',
      order_id: expiredOrderId,
      status: 'PAID',
    });
    expect(lateAfterSoldOut.status).toBe(200);
    expect(lateAfterSoldOut.body.resolution).toBe('LATE_EXPIRED_NEEDS_REFUND');
    expect(lateAfterSoldOut.body.refund_required).toBe(true);
    expect(lateAfterSoldOut.body.tickets).toEqual([]);

    const freshOrder = await request(app)
      .post('/api/orders')
      .set('X-Buyer-Id', 'buyer-03')
      .send({ ticket_type_id: regulerId, quantity: 1 });
    expect(freshOrder.status).toBe(409);

    const { orderId: cancelOrderId } = await seedEventAndOrder(5, 1, 'buyer-04');
    await request(app)
      .post(`/api/orders/${cancelOrderId}/cancel`)
      .set('X-Buyer-Id', 'buyer-04');

    const lateCancelled = await postSignedWebhook({
      webhook_id: 'wh-late-cancelled',
      order_id: cancelOrderId,
      status: 'PAID',
    });
    expect(lateCancelled.status).toBe(200);
    expect(lateCancelled.body.resolution).toBe('CANCELLED_NEEDS_REFUND');
    expect(lateCancelled.body.refund_required).toBe(true);
    expect(lateCancelled.body.tickets).toEqual([]);
  });

  it('logs failed payment webhook without cancelling pending order', async () => {
    const { orderId } = await seedEventAndOrder(5, 2, 'buyer-01');

    const failRes = await postSignedWebhook({
      webhook_id: 'wh-fail-1',
      order_id: orderId,
      status: 'FAILED',
    });
    expect(failRes.status).toBe(200);
    expect(failRes.body.resolution).toBe('FAILED_IGNORED');
    expect(failRes.body.order_status).toBe('PENDING');

    const retryPaid = await postSignedWebhook({
      webhook_id: 'wh-retry-ok',
      order_id: orderId,
      status: 'PAID',
    });
    expect(retryPaid.body.order_status).toBe('PAID');
    expect(retryPaid.body.tickets).toHaveLength(2);
  });

  it('supports payment simulator modes and webhook audit listing', async () => {
    const { orderId: o1 } = await seedEventAndOrder(10, 2, 'buyer-01');
    const { orderId: o2 } = await seedEventAndOrder(10, 1, 'buyer-02');

    const dupSim = await request(app)
      .post('/api/payments/simulate')
      .send({ order_id: o1, mode: 'duplicate' });
    expect(dupSim.status).toBe(200);
    expect(dupSim.body.first.resolution).toBe('PAID_ISSUED');
    expect(dupSim.body.second.idempotent_replay).toBe(true);
    expect(dupSim.body.second.tickets).toHaveLength(2);

    const lateSim = await request(app)
      .post('/api/payments/simulate')
      .send({ order_id: o2, mode: 'late' });
    expect(lateSim.status).toBe(200);
    expect(lateSim.body.resolution).toBe('LATE_EXPIRED_NEEDS_REFUND');

    const logs = await request(app).get(`/api/payments/webhooks?order_id=${o1}`);
    expect(logs.status).toBe(200);
    expect(logs.body.webhooks).toHaveLength(1);
    expect(logs.body.webhooks[0].resolution).toBe('PAID_ISSUED');
  });
});
