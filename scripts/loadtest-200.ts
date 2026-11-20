import { createHmac } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET ?? 'dev-webhook-secret-change-me';

async function main() {
  const healthRes = await fetch(`${API_URL}/healthz`);
  if (!healthRes.ok) {
    throw new Error(`Health check failed: HTTP ${healthRes.status}`);
  }

  const createRes = await fetch(`${API_URL}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Concurrency 200 Benchmark',
      venue: 'Main Hall',
      event_date: '2026-12-31T19:00:00+07:00',
      ticket_types: [
        { category: 'REGULER', price: 150000, quota: 100 },
        { category: 'VIP', price: 350000, quota: 50 },
      ],
    }),
  });
  if (createRes.status !== 201) {
    throw new Error(`Failed to create event: HTTP ${createRes.status}`);
  }

  const event = (await createRes.json()) as {
    id: string;
    ticket_types: Array<{ id: string; category: string }>;
  };
  const regulerId = event.ticket_types.find(
    (t) => t.category === 'REGULER'
  )!.id;

  let releaseGate!: () => void;
  const startGate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const startedAt = performance.now();
  const tasks = Array.from({ length: 200 }, (_, i) =>
    (async () => {
      await startGate;
      const res = await fetch(`${API_URL}/api/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Buyer-Id': `buyer-load-${String(i + 1).padStart(3, '0')}`,
        },
        body: JSON.stringify({ ticket_type_id: regulerId, quantity: 1 }),
      });
      const body = (await res.json()) as { id?: string; error?: string };
      return { status: res.status, body };
    })()
  );

  releaseGate();
  const results = await Promise.all(tasks);
  const bookingElapsedMs = Math.round(performance.now() - startedAt);

  const created = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409);
  const other = results.filter((r) => r.status !== 201 && r.status !== 409);

  const afterRes = await fetch(`${API_URL}/api/events/${event.id}`);
  const afterEvent = (await afterRes.json()) as {
    ticket_types: Array<{ category: string; available_quota: number }>;
  };
  const remainingQuota = afterEvent.ticket_types.find(
    (t) => t.category === 'REGULER'
  )!.available_quota;

  const ticketCodes = new Set<string>();
  const payStart = performance.now();
  const payResults = await Promise.all(
    created.map(async (item, idx) => {
      const raw = JSON.stringify({
        webhook_id: `wh-bench-${Date.now()}-${idx + 1}`,
        order_id: item.body.id,
        status: 'PAID',
      });
      const sig = createHmac('sha256', WEBHOOK_SECRET)
        .update(raw)
        .digest('hex');

      const res = await fetch(`${API_URL}/api/webhooks/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': sig,
        },
        body: raw,
      });
      const body = (await res.json()) as {
        resolution: string;
        tickets: Array<{ ticket_code: string }>;
      };
      for (const t of body.tickets ?? []) {
        ticketCodes.add(t.ticket_code);
      }
      return { status: res.status, resolution: body.resolution };
    })
  );
  const payElapsedMs = Math.round(performance.now() - payStart);
  const paidOk = payResults.filter(
    (p) => p.status === 200 && p.resolution === 'PAID_ISSUED'
  ).length;

  console.log('=== TicketID 200-Concurrent Benchmark ===');
  console.log(`Target URL            : ${API_URL}`);
  console.log(`Event ID              : ${event.id}`);
  console.log(`Total Requests        : 200`);
  console.log(`Ticket Quota          : 100`);
  console.log(`201 Created           : ${created.length}`);
  console.log(`409 Conflict          : ${conflicts.length}`);
  console.log(`Other / 5xx           : ${other.length}`);
  console.log(`Remaining Quota       : ${remainingQuota}`);
  console.log(`Orders Paid (200 OK)  : ${paidOk}`);
  console.log(`Unique Tickets Issued : ${ticketCodes.size}`);
  console.log(`Booking Burst Time    : ${bookingElapsedMs} ms`);
  console.log(`Webhook Settlement    : ${payElapsedMs} ms`);
  console.log('=======================================');

  if (
    created.length !== 100 ||
    conflicts.length !== 100 ||
    other.length !== 0 ||
    remainingQuota !== 0 ||
    ticketCodes.size !== 100
  ) {
    console.error('Concurrency invariant check FAILED');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Loadtest failed:', err);
  process.exit(1);
});
