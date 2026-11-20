import { pool } from '../src/db.js';

export async function resetDb(): Promise<void> {
  await pool.query(
    'TRUNCATE payment_webhooks, tickets, orders, buyer_event_quotas, ticket_types, events RESTART IDENTITY CASCADE'
  );
}
