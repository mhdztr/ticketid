import type { PoolClient } from 'pg';
import { clock } from '../clock.js';
import { generateCode } from '../codes.js';
import { config } from '../config.js';
import { pool, withTx } from '../db.js';
import { AppError } from '../errors.js';
import type { TicketCategory } from './eventService.js';

export type OrderStatus = 'PENDING' | 'PAID' | 'CANCELLED' | 'EXPIRED';

export interface OrderTicketItem {
  id: string;
  ticket_code: string;
  seat_seq: number;
  issued_at: string;
}

export interface OrderSummary {
  id: string;
  order_code: string;
  event_id: string;
  event_title: string;
  ticket_type_id: string;
  ticket_category: TicketCategory;
  buyer_id: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  status: OrderStatus;
  expires_at: string;
  paid_at: string | null;
  cancelled_at: string | null;
  expired_at: string | null;
  created_at: string;
  tickets: OrderTicketItem[];
}

export interface CreateOrderInput {
  buyerId: string;
  ticketTypeId: string;
  quantity: number;
}

interface OrderJoinedRow {
  id: string;
  order_code: string;
  event_id: string;
  event_title: string;
  ticket_type_id: string;
  ticket_category: TicketCategory;
  buyer_id: string;
  quantity: number;
  unit_price: string;
  total_price: string;
  status: OrderStatus;
  expires_at: Date;
  paid_at: Date | null;
  cancelled_at: Date | null;
  expired_at: Date | null;
  created_at: Date;
}

interface TicketRow {
  id: string;
  order_id: string;
  ticket_code: string;
  seat_seq: number;
  issued_at: Date;
}

function mapOrder(row: OrderJoinedRow, tickets: OrderTicketItem[]): OrderSummary {
  return {
    id: row.id,
    order_code: row.order_code,
    event_id: row.event_id,
    event_title: row.event_title,
    ticket_type_id: row.ticket_type_id,
    ticket_category: row.ticket_category,
    buyer_id: row.buyer_id,
    quantity: row.quantity,
    unit_price: Number(row.unit_price),
    total_price: Number(row.total_price),
    status: row.status,
    expires_at: row.expires_at.toISOString(),
    paid_at: row.paid_at ? row.paid_at.toISOString() : null,
    cancelled_at: row.cancelled_at ? row.cancelled_at.toISOString() : null,
    expired_at: row.expired_at ? row.expired_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    tickets,
  };
}

function mapTicket(row: TicketRow): OrderTicketItem {
  return {
    id: row.id,
    ticket_code: row.ticket_code,
    seat_seq: row.seat_seq,
    issued_at: row.issued_at.toISOString(),
  };
}

export async function releaseOrderQuota(
  client: PoolClient,
  eventId: string,
  buyerId: string,
  ticketTypeId: string,
  quantity: number
): Promise<void> {
  await client.query(
    `UPDATE buyer_event_quotas
     SET active_tickets = active_tickets - $3
     WHERE event_id = $1 AND buyer_id = $2`,
    [eventId, buyerId, quantity]
  );

  await client.query(
    `UPDATE ticket_types
     SET available_quota = available_quota + $2
     WHERE id = $1`,
    [ticketTypeId, quantity]
  );
}

export async function expirePendingOrders(batchSize = 50): Promise<number> {
  const now = clock.now();
  let totalSwept = 0;

  for (let batch = 0; batch < 20; batch++) {
    const swept = await withTx(async (client) => {
      const dueRes = await client.query<{ id: string }>(
        `SELECT id
         FROM orders
         WHERE status = 'PENDING' AND expires_at <= $1
         ORDER BY expires_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, batchSize]
      );

      if (dueRes.rows.length === 0) {
        return 0;
      }

      const dueIds = dueRes.rows.map((r) => r.id);
      const updatedRes = await client.query<{
        event_id: string;
        ticket_type_id: string;
        buyer_id: string;
        quantity: number;
      }>(
        `UPDATE orders
         SET status = 'EXPIRED', expired_at = $2
         WHERE id = ANY($1::uuid[]) AND status = 'PENDING'
         RETURNING event_id, ticket_type_id, buyer_id, quantity`,
        [dueIds, now]
      );

      if (updatedRes.rows.length === 0) {
        return 0;
      }

      const buyerTotals = new Map<
        string,
        { eventId: string; buyerId: string; quantity: number }
      >();
      const typeTotals = new Map<string, number>();

      for (const row of updatedRes.rows) {
        const buyerKey = `${row.event_id}:${row.buyer_id}`;
        const existingBuyer = buyerTotals.get(buyerKey);
        if (existingBuyer) {
          existingBuyer.quantity += row.quantity;
        } else {
          buyerTotals.set(buyerKey, {
            eventId: row.event_id,
            buyerId: row.buyer_id,
            quantity: row.quantity,
          });
        }

        typeTotals.set(
          row.ticket_type_id,
          (typeTotals.get(row.ticket_type_id) ?? 0) + row.quantity
        );
      }

      // Update aggregated quotas in sorted key order to preserve the lock DAG across concurrent sweepers
      for (const key of [...buyerTotals.keys()].sort()) {
        const item = buyerTotals.get(key)!;
        await client.query(
          `UPDATE buyer_event_quotas
           SET active_tickets = active_tickets - $3
           WHERE event_id = $1 AND buyer_id = $2`,
          [item.eventId, item.buyerId, item.quantity]
        );
      }

      for (const ticketTypeId of [...typeTotals.keys()].sort()) {
        await client.query(
          `UPDATE ticket_types
           SET available_quota = available_quota + $2
           WHERE id = $1`,
          [ticketTypeId, typeTotals.get(ticketTypeId)!]
        );
      }

      return updatedRes.rows.length;
    });

    totalSwept += swept;
    if (swept < batchSize) {
      break;
    }
  }

  return totalSwept;
}

async function tryCreateOrder(input: CreateOrderInput): Promise<OrderSummary> {
  return withTx(async (client) => {
    const ttRes = await client.query<{
      id: string;
      event_id: string;
      category: TicketCategory;
      price: string;
      event_title: string;
      max_tickets_per_buyer: number;
    }>(
      `SELECT tt.id, tt.event_id, tt.category, tt.price,
              e.title AS event_title, e.max_tickets_per_buyer
       FROM ticket_types tt
       JOIN events e ON e.id = tt.event_id
       WHERE tt.id = $1`,
      [input.ticketTypeId]
    );

    if (ttRes.rowCount === 0) {
      throw new AppError(404, 'TICKET_TYPE_NOT_FOUND', 'Ticket type not found');
    }
    const tt = ttRes.rows[0];

    // Lock buyer quota row first so concurrent requests across REGULER/VIP cannot exceed the event limit
    await client.query(
      `INSERT INTO buyer_event_quotas (event_id, buyer_id, active_tickets)
       VALUES ($1, $2, 0)
       ON CONFLICT (event_id, buyer_id) DO NOTHING`,
      [tt.event_id, input.buyerId]
    );

    const buyerLimitRes = await client.query(
      `UPDATE buyer_event_quotas
       SET active_tickets = active_tickets + $3
       WHERE event_id = $1 AND buyer_id = $2 AND active_tickets + $3 <= $4
       RETURNING active_tickets`,
      [tt.event_id, input.buyerId, input.quantity, tt.max_tickets_per_buyer]
    );

    if (buyerLimitRes.rowCount === 0) {
      throw new AppError(
        409,
        'BUYER_LIMIT_EXCEEDED',
        `Buyer can hold at most ${tt.max_tickets_per_buyer} active or paid tickets per event`
      );
    }

    const quotaRes = await client.query(
      `UPDATE ticket_types
       SET available_quota = available_quota - $1
       WHERE id = $2 AND available_quota >= $1
       RETURNING available_quota`,
      [input.quantity, tt.id]
    );

    if (quotaRes.rowCount === 0) {
      throw new AppError(
        409,
        'INSUFFICIENT_QUOTA',
        'Not enough tickets remaining for this ticket type'
      );
    }

    const now = clock.now();
    const expiresAt = new Date(now.getTime() + config.orderTtlSeconds * 1000);
    const unitPrice = Number(tt.price);
    const totalPrice = unitPrice * input.quantity;
    const orderCode = generateCode('ORD', 8);

    const orderRes = await client.query<
      Omit<OrderJoinedRow, 'event_title' | 'ticket_category'>
    >(
      `INSERT INTO orders (
         order_code, event_id, ticket_type_id, buyer_id,
         quantity, unit_price, total_price, status, expires_at, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9)
       RETURNING id, order_code, event_id, ticket_type_id, buyer_id,
                 quantity, unit_price, total_price, status, expires_at,
                 paid_at, cancelled_at, expired_at, created_at`,
      [
        orderCode,
        tt.event_id,
        tt.id,
        input.buyerId,
        input.quantity,
        unitPrice,
        totalPrice,
        expiresAt,
        now,
      ]
    );

    return mapOrder(
      {
        ...orderRes.rows[0],
        event_title: tt.event_title,
        ticket_category: tt.category,
      },
      []
    );
  });
}

export async function createOrder(input: CreateOrderInput): Promise<OrderSummary> {
  try {
    return await tryCreateOrder(input);
  } catch (err) {
    if (
      err instanceof AppError &&
      (err.code === 'INSUFFICIENT_QUOTA' || err.code === 'BUYER_LIMIT_EXCEEDED')
    ) {
      const swept = await expirePendingOrders();
      if (swept > 0) {
        return tryCreateOrder(input);
      }
    }
    throw err;
  }
}

export async function cancelOrder(
  buyerId: string,
  orderId: string
): Promise<OrderSummary> {
  const result = await withTx<
    { outcome: 'cancelled'; order: OrderSummary } | { outcome: 'expired' }
  >(async (client) => {
    const orderRes = await client.query<OrderJoinedRow>(
      `SELECT o.id, o.order_code, o.event_id, e.title AS event_title,
              o.ticket_type_id, tt.category AS ticket_category, o.buyer_id,
              o.quantity, o.unit_price, o.total_price, o.status,
              o.expires_at, o.paid_at, o.cancelled_at, o.expired_at, o.created_at
       FROM orders o
       JOIN events e ON e.id = o.event_id
       JOIN ticket_types tt ON tt.id = o.ticket_type_id
       WHERE o.id = $1
       FOR UPDATE OF o`,
      [orderId]
    );

    if (orderRes.rowCount === 0) {
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }

    const order = orderRes.rows[0];
    if (order.buyer_id !== buyerId) {
      throw new AppError(403, 'FORBIDDEN', 'Order belongs to another buyer');
    }

    if (order.status !== 'PENDING') {
      throw new AppError(
        409,
        'ORDER_NOT_CANCELLABLE',
        `Order cannot be cancelled from status ${order.status}`
      );
    }

    const now = clock.now();
    // Commit the expired state and quota release before throwing outside the transaction
    if (order.expires_at <= now) {
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
      return { outcome: 'expired' };
    }

    const updatedRes = await client.query<{
      status: OrderStatus;
      cancelled_at: Date;
    }>(
      `UPDATE orders
       SET status = 'CANCELLED', cancelled_at = $2
       WHERE id = $1 AND status = 'PENDING'
       RETURNING status, cancelled_at`,
      [order.id, now]
    );

    await releaseOrderQuota(
      client,
      order.event_id,
      order.buyer_id,
      order.ticket_type_id,
      order.quantity
    );

    return {
      outcome: 'cancelled',
      order: mapOrder(
        {
          ...order,
          status: updatedRes.rows[0].status,
          cancelled_at: updatedRes.rows[0].cancelled_at,
        },
        []
      ),
    };
  });

  if (result.outcome === 'expired') {
    throw new AppError(409, 'ORDER_EXPIRED', 'Order has already expired');
  }

  return result.order;
}

export async function listOrdersByBuyer(buyerId: string): Promise<OrderSummary[]> {
  await expirePendingOrders();
  const ordersRes = await pool.query<OrderJoinedRow>(
    `SELECT o.id, o.order_code, o.event_id, e.title AS event_title,
            o.ticket_type_id, tt.category AS ticket_category, o.buyer_id,
            o.quantity, o.unit_price, o.total_price, o.status,
            o.expires_at, o.paid_at, o.cancelled_at, o.expired_at, o.created_at
     FROM orders o
     JOIN events e ON e.id = o.event_id
     JOIN ticket_types tt ON tt.id = o.ticket_type_id
     WHERE o.buyer_id = $1
     ORDER BY o.created_at DESC, o.id DESC`,
    [buyerId]
  );

  if (ordersRes.rows.length === 0) {
    return [];
  }

  const orderIds = ordersRes.rows.map((o) => o.id);
  const ticketsRes = await pool.query<TicketRow>(
    `SELECT id, order_id, ticket_code, seat_seq, issued_at
     FROM tickets
     WHERE order_id = ANY($1::uuid[])
     ORDER BY seat_seq ASC`,
    [orderIds]
  );

  const byOrder = new Map<string, OrderTicketItem[]>();
  for (const row of ticketsRes.rows) {
    const list = byOrder.get(row.order_id) ?? [];
    list.push(mapTicket(row));
    byOrder.set(row.order_id, list);
  }

  return ordersRes.rows.map((row) => mapOrder(row, byOrder.get(row.id) ?? []));
}

export async function getOrderById(
  buyerId: string,
  orderId: string
): Promise<OrderSummary> {
  await expirePendingOrders();
  const orderRes = await pool.query<OrderJoinedRow>(
    `SELECT o.id, o.order_code, o.event_id, e.title AS event_title,
            o.ticket_type_id, tt.category AS ticket_category, o.buyer_id,
            o.quantity, o.unit_price, o.total_price, o.status,
            o.expires_at, o.paid_at, o.cancelled_at, o.expired_at, o.created_at
     FROM orders o
     JOIN events e ON e.id = o.event_id
     JOIN ticket_types tt ON tt.id = o.ticket_type_id
     WHERE o.id = $1`,
    [orderId]
  );

  if (orderRes.rowCount === 0) {
    throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
  }

  const order = orderRes.rows[0];
  if (order.buyer_id !== buyerId) {
    throw new AppError(403, 'FORBIDDEN', 'Order belongs to another buyer');
  }

  const ticketsRes = await pool.query<TicketRow>(
    `SELECT id, order_id, ticket_code, seat_seq, issued_at
     FROM tickets
     WHERE order_id = $1
     ORDER BY seat_seq ASC`,
    [order.id]
  );

  return mapOrder(order, ticketsRes.rows.map(mapTicket));
}
