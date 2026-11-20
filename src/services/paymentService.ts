import { createHmac, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { clock } from '../clock.js';
import { generateCode } from '../codes.js';
import { config } from '../config.js';
import { pool, withTx } from '../db.js';
import { AppError } from '../errors.js';
import { createEvent, type TicketCategory } from './eventService.js';
import {
  createOrder,
  type OrderStatus,
  type OrderTicketItem,
  releaseOrderQuota,
} from './orderService.js';

export type WebhookResolution =
  | 'PAID_ISSUED'
  | 'DUPLICATE_IGNORED'
  | 'LATE_EXPIRED_NEEDS_REFUND'
  | 'CANCELLED_NEEDS_REFUND'
  | 'FAILED_IGNORED';

export interface WebhookResult {
  webhook_id: string;
  order_id: string;
  order_status: OrderStatus;
  resolution: WebhookResolution;
  idempotent_replay: boolean;
  refund_required: boolean;
  tickets: OrderTicketItem[];
}

export interface BuyerTicketItem {
  id: string;
  ticket_code: string;
  seat_seq: number;
  issued_at: string;
  order_id: string;
  order_code: string;
  event_id: string;
  event_title: string;
  venue: string;
  event_date: string;
  category: TicketCategory;
}

export interface PaymentWebhookLog {
  id: string;
  webhook_id: string;
  order_id: string;
  provider_status: string;
  resolution: WebhookResolution;
  processed_at: string;
}

export function signWebhookPayload(rawBody: string | Buffer): string {
  return createHmac('sha256', config.webhookSecret)
    .update(rawBody)
    .digest('hex');
}

export function verifyWebhookSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined
): boolean {
  if (!rawBody || !signatureHeader) {
    return false;
  }

  const hexSig = signatureHeader.trim().replace(/^sha256=/i, '');
  if (!/^[0-9a-f]{64}$/i.test(hexSig)) {
    return false;
  }

  const expected = createHmac('sha256', config.webhookSecret)
    .update(rawBody)
    .digest();
  const provided = Buffer.from(hexSig, 'hex');
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

function mapTicket(row: {
  id: string;
  ticket_code: string;
  seat_seq: number;
  issued_at: Date;
}): OrderTicketItem {
  return {
    id: row.id,
    ticket_code: row.ticket_code,
    seat_seq: row.seat_seq,
    issued_at: row.issued_at.toISOString(),
  };
}

export async function processPaymentWebhook(input: {
  webhookId: string;
  orderId: string;
  status: 'PAID' | 'FAILED';
  rawPayload: unknown;
}): Promise<WebhookResult> {
  return withTx(async (client) => {
    // Lock the order row first so concurrent webhook deliveries serialize cleanly
    const orderRes = await client.query<{
      id: string;
      event_id: string;
      ticket_type_id: string;
      buyer_id: string;
      quantity: number;
      status: OrderStatus;
      expires_at: Date;
    }>(
      `SELECT id, event_id, ticket_type_id, buyer_id, quantity, status, expires_at
       FROM orders
       WHERE id = $1
       FOR UPDATE`,
      [input.orderId]
    );

    if (orderRes.rowCount === 0) {
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }
    const order = orderRes.rows[0];

    const existingHookRes = await client.query<{ resolution: WebhookResolution }>(
      `SELECT resolution
       FROM payment_webhooks
       WHERE webhook_id = $1`,
      [input.webhookId]
    );

    if (existingHookRes.rows.length > 0) {
      const existingTickets = await client.query<{
        id: string;
        ticket_code: string;
        seat_seq: number;
        issued_at: Date;
      }>(
        `SELECT id, ticket_code, seat_seq, issued_at
         FROM tickets
         WHERE order_id = $1
         ORDER BY seat_seq ASC`,
        [order.id]
      );
      const existingResolution = existingHookRes.rows[0].resolution;
      return {
        webhook_id: input.webhookId,
        order_id: order.id,
        order_status: order.status,
        resolution: existingResolution,
        idempotent_replay: true,
        refund_required: existingResolution.endsWith('NEEDS_REFUND'),
        tickets: existingTickets.rows.map(mapTicket),
      };
    }

    const now = clock.now();
    if (order.status === 'PENDING' && order.expires_at <= now) {
      await client.query(
        `UPDATE orders
         SET status = 'EXPIRED', expired_at = $2
         WHERE id = $1 AND status = 'PENDING'`,
        [order.id, now]
      );
      await releaseOrderQuota(
        client,
        order.event_id,
        order.buyer_id,
        order.ticket_type_id,
        order.quantity
      );
      order.status = 'EXPIRED';
    }

    let resolution: WebhookResolution;
    let idempotentReplay = false;
    let refundRequired = false;
    let tickets: OrderTicketItem[] = [];

    if (input.status === 'FAILED') {
      resolution = 'FAILED_IGNORED';
    } else if (order.status === 'PAID') {
      resolution = 'DUPLICATE_IGNORED';
      idempotentReplay = true;
      const existingTickets = await client.query<{
        id: string;
        ticket_code: string;
        seat_seq: number;
        issued_at: Date;
      }>(
        `SELECT id, ticket_code, seat_seq, issued_at
         FROM tickets
         WHERE order_id = $1
         ORDER BY seat_seq ASC`,
        [order.id]
      );
      tickets = existingTickets.rows.map(mapTicket);
    } else if (order.status === 'EXPIRED') {
      resolution = 'LATE_EXPIRED_NEEDS_REFUND';
      refundRequired = true;
    } else if (order.status === 'CANCELLED') {
      resolution = 'CANCELLED_NEEDS_REFUND';
      refundRequired = true;
    } else {
      await client.query(
        `UPDATE orders
         SET status = 'PAID', paid_at = $2
         WHERE id = $1 AND status = 'PENDING'`,
        [order.id, now]
      );
      order.status = 'PAID';

      for (let seatSeq = 1; seatSeq <= order.quantity; seatSeq++) {
        const ticketCode = generateCode('TKT', 10);
        const ticketRes = await client.query<{
          id: string;
          ticket_code: string;
          seat_seq: number;
          issued_at: Date;
        }>(
          `INSERT INTO tickets (
             order_id, event_id, ticket_type_id, buyer_id, seat_seq, ticket_code, issued_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, ticket_code, seat_seq, issued_at`,
          [
            order.id,
            order.event_id,
            order.ticket_type_id,
            order.buyer_id,
            seatSeq,
            ticketCode,
            now,
          ]
        );
        tickets.push(mapTicket(ticketRes.rows[0]));
      }
      resolution = 'PAID_ISSUED';
    }

    await client.query(
      `INSERT INTO payment_webhooks (
         webhook_id, order_id, provider_status, resolution, raw_payload, processed_at
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (webhook_id) DO NOTHING`,
      [
        input.webhookId,
        order.id,
        input.status,
        resolution,
        JSON.stringify(input.rawPayload),
        now,
      ]
    );

    return {
      webhook_id: input.webhookId,
      order_id: order.id,
      order_status: order.status,
      resolution,
      idempotent_replay: idempotentReplay,
      refund_required: refundRequired,
      tickets,
    };
  });
}

export async function simulatePayment(
  orderId: string,
  mode: 'normal' | 'duplicate' | 'late' | 'failed'
): Promise<WebhookResult | { first: WebhookResult; second: WebhookResult }> {
  if (mode === 'late') {
    const pastTime = new Date(clock.now().getTime() - 1000);
    await pool.query(
      `UPDATE orders
       SET expires_at = $2
       WHERE id = $1 AND status = 'PENDING'`,
      [orderId, pastTime]
    );
  }

  const webhookId = generateCode('WH', 10);
  const status = mode === 'failed' ? 'FAILED' : 'PAID';
  const payload = { webhook_id: webhookId, order_id: orderId, status };

  const first = await processPaymentWebhook({
    webhookId,
    orderId,
    status,
    rawPayload: payload,
  });

  if (mode === 'duplicate') {
    const second = await processPaymentWebhook({
      webhookId,
      orderId,
      status,
      rawPayload: payload,
    });
    return { first, second };
  }

  return first;
}

export async function listPaymentWebhooks(
  orderId?: string
): Promise<PaymentWebhookLog[]> {
  const res = orderId
    ? await pool.query<{
        id: string;
        webhook_id: string;
        order_id: string;
        provider_status: string;
        resolution: WebhookResolution;
        processed_at: Date;
      }>(
        `SELECT id, webhook_id, order_id, provider_status, resolution, processed_at
         FROM payment_webhooks
         WHERE order_id = $1
         ORDER BY processed_at DESC
         LIMIT 50`,
        [orderId]
      )
    : await pool.query<{
        id: string;
        webhook_id: string;
        order_id: string;
        provider_status: string;
        resolution: WebhookResolution;
        processed_at: Date;
      }>(
        `SELECT id, webhook_id, order_id, provider_status, resolution, processed_at
         FROM payment_webhooks
         ORDER BY processed_at DESC
         LIMIT 50`
      );

  return res.rows.map((row) => ({
    ...row,
    processed_at: row.processed_at.toISOString(),
  }));
}

export async function listTicketsByBuyer(
  buyerId: string
): Promise<BuyerTicketItem[]> {
  const res = await pool.query<{
    id: string;
    ticket_code: string;
    seat_seq: number;
    issued_at: Date;
    order_id: string;
    order_code: string;
    event_id: string;
    event_title: string;
    venue: string;
    event_date: Date;
    category: TicketCategory;
  }>(
    `SELECT t.id, t.ticket_code, t.seat_seq, t.issued_at,
            o.id AS order_id, o.order_code,
            e.id AS event_id, e.title AS event_title, e.venue, e.event_date,
            tt.category
     FROM tickets t
     JOIN orders o ON o.id = t.order_id
     JOIN events e ON e.id = t.event_id
     JOIN ticket_types tt ON tt.id = t.ticket_type_id
     WHERE t.buyer_id = $1
     ORDER BY t.issued_at DESC, t.seat_seq ASC`,
    [buyerId]
  );

  return res.rows.map((row) => ({
    id: row.id,
    ticket_code: row.ticket_code,
    seat_seq: row.seat_seq,
    issued_at: row.issued_at.toISOString(),
    order_id: row.order_id,
    order_code: row.order_code,
    event_id: row.event_id,
    event_title: row.event_title,
    venue: row.venue,
    event_date: row.event_date.toISOString(),
    category: row.category,
  }));
}

export interface ConcurrencyDemoResult {
  event_id: string;
  total_requests: number;
  quota: number;
  created: number;
  conflicts: number;
  other: number;
  remaining_quota: number;
  elapsed_ms: number;
}

export async function runConcurrencyDemo(): Promise<ConcurrencyDemoResult> {
  const event = await createEvent({
    title: 'BoxOffice Burst 200',
    description: '200 concurrent orders against 100 REGULER tickets',
    venue: 'Concurrency Bench',
    event_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    max_tickets_per_buyer: 4,
    ticket_types: [
      { category: 'REGULER', price: 150000, quota: 100 },
      { category: 'VIP', price: 350000, quota: 20 },
    ],
  });

  const reguler = event.ticket_types.find((t) => t.category === 'REGULER')!;
  const startedAt = performance.now();

  // Dispatch directly against the service layer so browser HTTP connection caps do not mask concurrency
  const settled = await Promise.allSettled(
    Array.from({ length: 200 }, (_, i) =>
      createOrder({
        buyerId: `buyer-burst-${String(i + 1).padStart(3, '0')}`,
        ticketTypeId: reguler.id,
        quantity: 1,
      })
    )
  );
  const elapsedMs = Math.round(performance.now() - startedAt);

  let created = 0;
  let conflicts = 0;
  let other = 0;

  for (const item of settled) {
    if (item.status === 'fulfilled') {
      created++;
    } else if (
      item.reason instanceof AppError &&
      item.reason.statusCode === 409
    ) {
      conflicts++;
    } else {
      other++;
    }
  }

  const quotaRes = await pool.query<{ available_quota: number }>(
    'SELECT available_quota FROM ticket_types WHERE id = $1',
    [reguler.id]
  );

  return {
    event_id: event.id,
    total_requests: 200,
    quota: 100,
    created,
    conflicts,
    other,
    remaining_quota: quotaRes.rows[0].available_quota,
    elapsed_ms: elapsedMs,
  };
}
