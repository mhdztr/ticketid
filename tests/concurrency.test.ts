import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetClock } from '../src/clock.js';
import { config } from '../src/config.js';
import { initSchema, pool } from '../src/db.js';
import { resetDb } from './setup.js';

describe('High concurrency 200-request booking tests', () => {
  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    await initSchema();
    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  beforeEach(async () => {
    await resetDb();
    resetClock();
  });

  afterAll(async () => {
    resetClock();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
    await pool.end();
  });

  async function createBenchmarkEvent(regulerQuota: number, vipQuota: number) {
    const res = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Concurrency Stress Event',
        venue: 'Main Arena',
        event_date: '2026-12-31T19:00:00+07:00',
        ticket_types: [
          { category: 'REGULER', price: 150000, quota: regulerQuota },
          { category: 'VIP', price: 350000, quota: vipQuota },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      ticket_types: Array<{ id: string; category: string }>;
    };
    const reguler = body.ticket_types.find((t) => t.category === 'REGULER')!;
    return { eventId: body.id, regulerId: reguler.id };
  }

  it('handles 200 concurrent orders for 100 quota with exact 100 sold and 0 oversell', async () => {
    const { eventId, regulerId } = await createBenchmarkEvent(100, 20);

    let releaseGate!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const requests = Array.from({ length: 200 }, (_, i) => async () => {
      await startGate;
      const res = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Buyer-Id': `buyer-${String(i + 1).padStart(3, '0')}`,
        },
        body: JSON.stringify({ ticket_type_id: regulerId, quantity: 1 }),
      });
      const data = (await res.json()) as { id?: string; error?: string };
      return { status: res.status, data };
    });

    const tasks = requests.map((fn) => fn());
    releaseGate();
    const results = await Promise.all(tasks);

    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter(
      (r) => r.status === 409 && r.data.error === 'INSUFFICIENT_QUOTA'
    );
    const other = results.filter((r) => r.status !== 201 && r.status !== 409);

    expect(created).toHaveLength(100);
    expect(conflicts).toHaveLength(100);
    expect(other).toHaveLength(0);

    const eventRes = await fetch(`${baseUrl}/api/events/${eventId}`);
    const eventData = (await eventRes.json()) as {
      ticket_types: Array<{ category: string; available_quota: number }>;
    };
    const regulerAfter = eventData.ticket_types.find(
      (t) => t.category === 'REGULER'
    )!;
    expect(regulerAfter.available_quota).toBe(0);

    const dbOrders = await pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM orders WHERE event_id = $1 AND status = 'PENDING'`,
      [eventId]
    );
    expect(Number(dbOrders.rows[0].count)).toBe(100);

    const payResults = await Promise.all(
      created.map(async (item, idx) => {
        const raw = JSON.stringify({
          webhook_id: `wh-conc-${idx + 1}`,
          order_id: item.data.id,
          status: 'PAID',
        });
        const sig = createHmac('sha256', config.webhookSecret)
          .update(raw)
          .digest('hex');

        const res = await fetch(`${baseUrl}/api/webhooks/payments`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Signature': sig,
          },
          body: raw,
        });
        return {
          status: res.status,
          body: (await res.json()) as { resolution: string },
        };
      })
    );

    expect(payResults.every((p) => p.status === 200)).toBe(true);
    expect(
      payResults.every((p) => p.body.resolution === 'PAID_ISSUED')
    ).toBe(true);

    const dbTickets = await pool.query<{ count: string; unique_codes: string }>(
      `SELECT COUNT(*) AS count, COUNT(DISTINCT ticket_code) AS unique_codes
       FROM tickets WHERE event_id = $1`,
      [eventId]
    );
    expect(Number(dbTickets.rows[0].count)).toBe(100);
    expect(Number(dbTickets.rows[0].unique_codes)).toBe(100);
  });

  it('conserves quota across 200 concurrent orders with mixed quantities 1-4', async () => {
    const { eventId, regulerId } = await createBenchmarkEvent(100, 20);

    let releaseGate!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const requests = Array.from({ length: 200 }, (_, i) => async () => {
      await startGate;
      const qty = (i % 4) + 1;
      const res = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Buyer-Id': `buyer-mix-${String(i + 1).padStart(3, '0')}`,
        },
        body: JSON.stringify({ ticket_type_id: regulerId, quantity: qty }),
      });
      const data = (await res.json()) as { quantity?: number; error?: string };
      return { status: res.status, data };
    });

    const tasks = requests.map((fn) => fn());
    releaseGate();
    const results = await Promise.all(tasks);

    const serverErrors = results.filter((r) => r.status >= 500);
    expect(serverErrors).toHaveLength(0);

    const reservedTotal = results
      .filter((r) => r.status === 201)
      .reduce((sum, r) => sum + (r.data.quantity ?? 0), 0);

    const eventRes = await fetch(`${baseUrl}/api/events/${eventId}`);
    const eventData = (await eventRes.json()) as {
      ticket_types: Array<{ category: string; available_quota: number }>;
    };
    const remaining = eventData.ticket_types.find(
      (t) => t.category === 'REGULER'
    )!.available_quota;

    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(reservedTotal + remaining).toBe(100);

    if (remaining > 0) {
      const topUp = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Buyer-Id': 'buyer-mix-final',
        },
        body: JSON.stringify({ ticket_type_id: regulerId, quantity: remaining }),
      });
      expect(topUp.status).toBe(201);

      const finalEvent = await fetch(`${baseUrl}/api/events/${eventId}`);
      const finalData = (await finalEvent.json()) as {
        ticket_types: Array<{ category: string; available_quota: number }>;
      };
      expect(
        finalData.ticket_types.find((t) => t.category === 'REGULER')!
          .available_quota
      ).toBe(0);
    }
  });
});
