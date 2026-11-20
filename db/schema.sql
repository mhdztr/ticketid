CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  venue TEXT NOT NULL,
  event_date TIMESTAMPTZ NOT NULL,
  max_tickets_per_buyer INT NOT NULL DEFAULT 4 CHECK (max_tickets_per_buyer > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('REGULER', 'VIP')),
  price BIGINT NOT NULL CHECK (price >= 0),
  total_quota INT NOT NULL CHECK (total_quota > 0),
  available_quota INT NOT NULL CHECK (available_quota >= 0 AND available_quota <= total_quota),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, category)
);

CREATE TABLE IF NOT EXISTS buyer_event_quotas (
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  buyer_id TEXT NOT NULL,
  active_tickets INT NOT NULL DEFAULT 0 CHECK (active_tickets >= 0 AND active_tickets <= 4),
  PRIMARY KEY (event_id, buyer_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_code TEXT NOT NULL UNIQUE,
  event_id UUID NOT NULL REFERENCES events(id),
  ticket_type_id UUID NOT NULL REFERENCES ticket_types(id),
  buyer_id TEXT NOT NULL,
  quantity INT NOT NULL CHECK (quantity >= 1 AND quantity <= 4),
  unit_price BIGINT NOT NULL,
  total_price BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PAID', 'CANCELLED', 'EXPIRED')),
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_pending_expires
  ON orders (expires_at) WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_orders_buyer
  ON orders (buyer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  event_id UUID NOT NULL REFERENCES events(id),
  ticket_type_id UUID NOT NULL REFERENCES ticket_types(id),
  buyer_id TEXT NOT NULL,
  seat_seq INT NOT NULL CHECK (seat_seq >= 1 AND seat_seq <= 4),
  ticket_code TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, seat_seq)
);

CREATE TABLE IF NOT EXISTS payment_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id TEXT NOT NULL UNIQUE,
  order_id UUID NOT NULL REFERENCES orders(id),
  provider_status TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN (
    'PAID_ISSUED',
    'DUPLICATE_IGNORED',
    'LATE_EXPIRED_NEEDS_REFUND',
    'CANCELLED_NEEDS_REFUND',
    'FAILED_IGNORED'
  )),
  raw_payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
