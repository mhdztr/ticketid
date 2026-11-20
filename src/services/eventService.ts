import { pool, withTx } from '../db.js';
import { AppError } from '../errors.js';

export type TicketCategory = 'REGULER' | 'VIP';

export interface TicketTypeItem {
  id: string;
  event_id: string;
  category: TicketCategory;
  price: number;
  total_quota: number;
  available_quota: number;
  created_at: string;
}

export interface EventWithTickets {
  id: string;
  title: string;
  description: string;
  venue: string;
  event_date: string;
  max_tickets_per_buyer: number;
  created_at: string;
  ticket_types: TicketTypeItem[];
}

export interface CreateEventInput {
  title: string;
  description: string;
  venue: string;
  event_date: string;
  max_tickets_per_buyer: number;
  ticket_types: Array<{
    category: TicketCategory;
    price: number;
    quota: number;
  }>;
}

interface EventRow {
  id: string;
  title: string;
  description: string;
  venue: string;
  event_date: Date;
  max_tickets_per_buyer: number;
  created_at: Date;
}

interface TicketTypeRow {
  id: string;
  event_id: string;
  category: TicketCategory;
  price: string;
  total_quota: number;
  available_quota: number;
  created_at: Date;
}

function mapTicketType(row: TicketTypeRow): TicketTypeItem {
  return {
    id: row.id,
    event_id: row.event_id,
    category: row.category,
    // pg parses BIGINT as string to prevent precision loss on huge values
    price: Number(row.price),
    total_quota: row.total_quota,
    available_quota: row.available_quota,
    created_at: row.created_at.toISOString(),
  };
}

function mapEvent(row: EventRow, ticketTypes: TicketTypeItem[]): EventWithTickets {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    venue: row.venue,
    event_date: row.event_date.toISOString(),
    max_tickets_per_buyer: row.max_tickets_per_buyer,
    created_at: row.created_at.toISOString(),
    ticket_types: ticketTypes,
  };
}

export async function createEvent(input: CreateEventInput): Promise<EventWithTickets> {
  return withTx(async (client) => {
    const eventRes = await client.query<EventRow>(
      `INSERT INTO events (title, description, venue, event_date, max_tickets_per_buyer)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, description, venue, event_date, max_tickets_per_buyer, created_at`,
      [
        input.title,
        input.description,
        input.venue,
        input.event_date,
        input.max_tickets_per_buyer,
      ]
    );
    const eventRow = eventRes.rows[0];

    const sortedInput = [...input.ticket_types].sort((a, b) =>
      a.category.localeCompare(b.category)
    );
    const ticketTypes: TicketTypeItem[] = [];

    for (const tt of sortedInput) {
      const ttRes = await client.query<TicketTypeRow>(
        `INSERT INTO ticket_types (event_id, category, price, total_quota, available_quota)
         VALUES ($1, $2, $3, $4, $4)
         RETURNING id, event_id, category, price, total_quota, available_quota, created_at`,
        [eventRow.id, tt.category, tt.price, tt.quota]
      );
      ticketTypes.push(mapTicketType(ttRes.rows[0]));
    }

    return mapEvent(eventRow, ticketTypes);
  });
}

export async function listEvents(): Promise<EventWithTickets[]> {
  const eventsRes = await pool.query<EventRow>(
    `SELECT id, title, description, venue, event_date, max_tickets_per_buyer, created_at
     FROM events
     ORDER BY created_at DESC`
  );

  if (eventsRes.rows.length === 0) {
    return [];
  }

  const eventIds = eventsRes.rows.map((e) => e.id);
  const ttRes = await pool.query<TicketTypeRow>(
    `SELECT id, event_id, category, price, total_quota, available_quota, created_at
     FROM ticket_types
     WHERE event_id = ANY($1::uuid[])
     ORDER BY category ASC`,
    [eventIds]
  );

  const byEvent = new Map<string, TicketTypeItem[]>();
  for (const row of ttRes.rows) {
    const list = byEvent.get(row.event_id) ?? [];
    list.push(mapTicketType(row));
    byEvent.set(row.event_id, list);
  }

  return eventsRes.rows.map((row) => mapEvent(row, byEvent.get(row.id) ?? []));
}

export async function getEventById(eventId: string): Promise<EventWithTickets> {
  const eventRes = await pool.query<EventRow>(
    `SELECT id, title, description, venue, event_date, max_tickets_per_buyer, created_at
     FROM events
     WHERE id = $1`,
    [eventId]
  );

  if (eventRes.rowCount === 0) {
    throw new AppError(404, 'EVENT_NOT_FOUND', 'Event not found');
  }

  const ttRes = await pool.query<TicketTypeRow>(
    `SELECT id, event_id, category, price, total_quota, available_quota, created_at
     FROM ticket_types
     WHERE event_id = $1
     ORDER BY category ASC`,
    [eventId]
  );

  return mapEvent(eventRes.rows[0], ttRes.rows.map(mapTicketType));
}
