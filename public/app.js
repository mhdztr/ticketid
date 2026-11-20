'use strict';

const state = {
  buyerId: localStorage.getItem('ticketid_buyer') || 'buyer-01',
  events: [],
  orders: [],
  tickets: [],
  webhooks: [],
  bookTarget: null,
  bookQty: 1,
  expiryRefreshSent: false,
};

const el = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatIdr(amount) {
  return 'Rp ' + Number(amount || 0).toLocaleString('id-ID');
}

function formatDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatCountdown(expiresIso) {
  const diff = Math.floor((new Date(expiresIso).getTime() - Date.now()) / 1000);
  if (diff <= 0) return '00:00';
  const m = String(Math.floor(diff / 60)).padStart(2, '0');
  const s = String(diff % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function showToast(html, kind) {
  const box = el('toast');
  if (!html) {
    box.hidden = true;
    el('toastText').innerHTML = '';
    box.className = 'xp-toast';
    return;
  }
  box.hidden = false;
  box.className = `xp-toast ${kind || ''}`.trim();
  el('toastText').innerHTML = html;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}), 'X-Buyer-Id': state.buyerId };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    const err = new Error((data && data.message) || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data && data.error;
    throw err;
  }
  return data;
}

function switchTab(tabName) {
  document.querySelectorAll('.xp-tab').forEach((btn) => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.xp-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.id === `pane-${tabName}`);
  });
}

function renderEvents() {
  const container = el('eventsContainer');
  if (state.events.length === 0) {
    container.innerHTML = `
      <div class="xp-empty">
        <div>No events yet</div>
        <div class="xp-empty-actions">
          <button type="button" class="xp-btn xp-btn-primary" data-empty-action="new">+ New Event</button>
          <button type="button" class="xp-btn" data-empty-action="seed">Add Sample Event</button>
        </div>
      </div>`;
    return;
  }

  container.innerHTML = state.events
    .map((ev) => {
      const tiers = ev.ticket_types
        .map((tt) => {
          const pct = tt.total_quota > 0 ? Math.round((tt.available_quota / tt.total_quota) * 100) : 0;
          const soldOut = tt.available_quota <= 0;
          return `
            <div class="xp-tier-bar">
              <div class="xp-tier-top">
                <span class="xp-tier-name">${esc(tt.category)}</span>
                <span class="xp-tier-price num">${esc(formatIdr(tt.price))}</span>
              </div>
              <div class="xp-tier-bottom">
                <div class="xp-progress"><div class="xp-progress-fill" style="width: ${pct}%"></div></div>
                <span class="xp-tier-count num">${tt.available_quota} / ${tt.total_quota}</span>
                <button
                  type="button"
                  class="xp-btn xp-btn-sm xp-btn-primary"
                  data-buy-event="${esc(ev.id)}"
                  data-buy-tier="${esc(tt.id)}"
                  ${soldOut ? 'disabled' : ''}
                >${soldOut ? 'Sold out' : 'Buy'}</button>
              </div>
            </div>`;
        })
        .join('');

      return `
        <article class="xp-event-row">
          <div class="xp-event-head">
            <span class="xp-event-title">${esc(ev.title)}</span>
            <span class="xp-event-meta">${esc(ev.venue)} · ${esc(formatDate(ev.event_date))}</span>
          </div>
          <div class="xp-tiers">${tiers}</div>
        </article>`;
    })
    .join('');
}

function badgeClass(status) {
  const map = {
    PENDING: 'xp-badge-pending',
    PAID: 'xp-badge-paid',
    CANCELLED: 'xp-badge-cancelled',
    EXPIRED: 'xp-badge-expired',
  };
  return map[status] || '';
}

function renderOrders() {
  el('tabOrdersBtn').textContent = `Orders (${state.orders.length})`;
  const tbody = el('ordersTbody');

  if (state.orders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="xp-empty">No orders for this user</td></tr>';
    return;
  }

  tbody.innerHTML = state.orders
    .map((ord) => {
      const countdown =
        ord.status === 'PENDING'
          ? `<span class="xp-countdown num" data-expires="${esc(ord.expires_at)}">${esc(formatCountdown(ord.expires_at))}</span>`
          : '';

      let actions = '';
      if (ord.status === 'PENDING') {
        actions = `
          <button type="button" class="xp-btn xp-btn-sm xp-btn-primary" data-order-action="pay" data-id="${esc(ord.id)}">Pay</button>
          <button type="button" class="xp-btn xp-btn-sm" data-order-action="cancel" data-id="${esc(ord.id)}">Cancel</button>
          <button type="button" class="xp-btn xp-btn-sm" data-order-action="late" data-id="${esc(ord.id)}">Late</button>`;
      } else if (ord.status === 'PAID') {
        actions = `
          <button type="button" class="xp-btn xp-btn-sm" data-order-action="duplicate" data-id="${esc(ord.id)}">Re-pay</button>`;
      } else {
        actions = `
          <button type="button" class="xp-btn xp-btn-sm" data-order-action="late" data-id="${esc(ord.id)}">Late</button>`;
      }

      return `
        <tr>
          <td class="mono">${esc(ord.order_code)}</td>
          <td><strong>${esc(ord.event_title)}</strong> · ${ord.quantity}x ${esc(ord.ticket_category)}</td>
          <td class="num">${esc(formatIdr(ord.total_price))}</td>
          <td><span class="xp-badge ${badgeClass(ord.status)}">${esc(ord.status)}</span>${countdown}</td>
          <td><div class="xp-actions">${actions}</div></td>
        </tr>`;
    })
    .join('');
}

function renderTickets() {
  el('tabTicketsBtn').textContent = `Tickets (${state.tickets.length})`;
  const container = el('ticketsContainer');

  if (state.tickets.length === 0) {
    container.innerHTML = '<div class="xp-empty" style="grid-column: 1 / -1">No issued tickets yet</div>';
    return;
  }

  container.innerHTML = state.tickets
    .map(
      (t) => `
      <div class="ticket-card">
        <div class="ticket-card-top">
          <span class="ticket-code">${esc(t.ticket_code)}</span>
          <span class="xp-badge xp-badge-paid">${esc(t.category)} · #${t.seat_seq}</span>
        </div>
        <div class="ticket-card-body">
          <strong>${esc(t.event_title)}</strong>
          <span>${esc(t.venue)} · ${esc(formatDate(t.event_date))}</span>
          <span class="mono" style="color: #5a5a52">${esc(t.order_code)}</span>
        </div>
      </div>`
    )
    .join('');
}

function renderWebhooks() {
  const tbody = el('webhooksTbody');
  const recent = state.webhooks.slice(0, 20);
  if (recent.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="xp-empty">No webhook events yet</td></tr>';
    return;
  }

  const codeById = new Map(state.orders.map((o) => [o.id, o.order_code]));
  tbody.innerHTML = recent
    .map(
      (wh) => `
      <tr>
        <td class="mono">${esc(codeById.get(wh.order_id) || wh.order_id.slice(0, 8))}</td>
        <td>${esc(wh.provider_status)}</td>
        <td class="mono">${esc(wh.resolution)}</td>
        <td class="num">${esc(formatTime(wh.processed_at))}</td>
      </tr>`
    )
    .join('');
}

async function refreshAll() {
  try {
    const [health, evData, ordData, tktData, whData] = await Promise.all([
      api('/healthz'),
      api('/api/events'),
      api('/api/orders'),
      api('/api/tickets'),
      api('/api/payments/webhooks'),
    ]);

    state.events = evData.events || [];
    state.orders = ordData.orders || [];
    state.tickets = tktData.tickets || [];
    state.webhooks = whData.webhooks || [];
    state.expiryRefreshSent = false;

    el('statusDb').textContent = health.db === 'up' ? 'DB: OK' : 'DB: Down';
    renderEvents();
    renderOrders();
    renderTickets();
    renderWebhooks();
  } catch (err) {
    el('statusDb').textContent = 'DB: Error';
    el('statusMsg').textContent = err.message;
  }
}

function switchBuyer(nextBuyer) {
  const clean = nextBuyer.trim();
  if (!clean || clean === state.buyerId) return;
  state.buyerId = clean;
  localStorage.setItem('ticketid_buyer', clean);
  el('buyerInput').value = clean;
  el('statusMsg').textContent = `Active user: ${clean}`;
  showToast('');
  refreshAll();
}

function openBookDialog(eventId, tierId) {
  const ev = state.events.find((e) => e.id === eventId);
  const tt = ev && ev.ticket_types.find((t) => t.id === tierId);
  if (!ev || !tt) return;

  state.bookTarget = { event: ev, tier: tt };
  state.bookQty = 1;
  el('dlgEventTitle').textContent = ev.title;
  el('dlgTierMeta').textContent = `${tt.category} · ${formatIdr(tt.price)} · ${tt.available_quota} left`;
  updateQtyUi();
  el('bookDialog').showModal();
}

function updateQtyUi() {
  document.querySelectorAll('#qtyButtons .xp-qty-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.qty) === state.bookQty);
  });
  const price = state.bookTarget ? state.bookTarget.tier.price : 0;
  el('dlgTotal').textContent = formatIdr(price * state.bookQty);
}

async function seedSampleEvent() {
  el('statusMsg').textContent = 'Creating sample event...';
  try {
    const created = await api('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        title: `Indie Night #${Math.floor(100 + Math.random() * 900)}`,
        venue: 'Hall A Jakarta',
        event_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        ticket_types: [
          { category: 'REGULER', price: 150000, quota: 10 },
          { category: 'VIP', price: 350000, quota: 5 },
        ],
      }),
    });
    showToast(`Created ${esc(created.title)}`, 'ok');
    el('statusMsg').textContent = `Created ${created.title}`;
    await refreshAll();
  } catch (err) {
    showToast(esc(err.message), 'error');
  }
}

async function handleBookSubmit(e) {
  e.preventDefault();
  if (!state.bookTarget) return;
  const target = state.bookTarget;

  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        ticket_type_id: target.tier.id,
        quantity: state.bookQty,
      }),
    });
    el('bookDialog').close();
    showToast(
      `Booked <strong>${esc(order.order_code)}</strong> (${order.quantity}x ${esc(order.ticket_category)}) <button type="button" class="xp-btn-link" data-jump-tab="orders">Go to Orders -&gt;</button>`,
      'ok'
    );
    el('statusMsg').textContent = `Reserved ${order.order_code}`;
    await refreshAll();
  } catch (err) {
    el('bookDialog').close();
    showToast(esc(err.message), 'error');
    el('statusMsg').textContent = err.message;
  }
}

async function handleCreateEvent(e) {
  e.preventDefault();
  const rawDate = el('evDate').value;
  if (!rawDate) return;

  try {
    const created = await api('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        title: el('evTitle').value.trim(),
        venue: el('evVenue').value.trim(),
        event_date: new Date(rawDate).toISOString(),
        ticket_types: [
          {
            category: 'REGULER',
            price: Number(el('evRegPrice').value),
            quota: Number(el('evRegQuota').value),
          },
          {
            category: 'VIP',
            price: Number(el('evVipPrice').value),
            quota: Number(el('evVipQuota').value),
          },
        ],
      }),
    });
    el('eventDialog').close();
    switchTab('events');
    showToast(`Created <strong>${esc(created.title)}</strong>`, 'ok');
    el('statusMsg').textContent = `Created ${created.title}`;
    await refreshAll();
  } catch (err) {
    showToast(esc(err.message), 'error');
  }
}

async function handleOrderAction(action, orderId) {
  try {
    if (action === 'cancel') {
      const res = await api(`/api/orders/${orderId}/cancel`, { method: 'POST' });
      showToast(`Cancelled <strong>${esc(res.order_code)}</strong> · quota restored`, 'ok');
      el('statusMsg').textContent = `Cancelled ${res.order_code}`;
    } else if (action === 'pay') {
      const res = await api('/api/payments/simulate', {
        method: 'POST',
        body: JSON.stringify({ order_id: orderId, mode: 'normal' }),
      });
      showToast(
        `Paid · issued ${res.tickets.length} ticket(s) <button type="button" class="xp-btn-link" data-jump-tab="tickets">View Tickets -&gt;</button>`,
        'ok'
      );
      el('statusMsg').textContent = `Paid (${res.resolution})`;
    } else if (action === 'duplicate') {
      const res = await api('/api/payments/simulate', {
        method: 'POST',
        body: JSON.stringify({ order_id: orderId, mode: 'duplicate' }),
      });
      showToast(
        `Duplicate replay ignored (${esc(res.second.resolution)}) · still ${res.second.tickets.length} ticket(s)`,
        'ok'
      );
      el('statusMsg').textContent = 'Idempotent replay verified';
    } else if (action === 'late') {
      const res = await api('/api/payments/simulate', {
        method: 'POST',
        body: JSON.stringify({ order_id: orderId, mode: 'late' }),
      });
      showToast(
        `Late webhook rejected tickets · <strong>${esc(res.resolution)}</strong>`,
        'error'
      );
      el('statusMsg').textContent = res.resolution;
    }
    await refreshAll();
  } catch (err) {
    showToast(esc(err.message), 'error');
    await refreshAll();
  }
}

async function handleBurstDemo() {
  const btn = el('runBurstBtn');
  btn.disabled = true;
  el('statusMsg').textContent = 'Running 200 concurrent orders...';

  try {
    const res = await api('/api/payments/concurrency-demo', { method: 'POST' });
    el('burstMetrics').innerHTML = `
      <div class="xp-metric">
        <div class="xp-metric-label">Sold (201)</div>
        <div class="xp-metric-val num">${res.created}</div>
      </div>
      <div class="xp-metric">
        <div class="xp-metric-label">Sold Out (409)</div>
        <div class="xp-metric-val num">${res.conflicts}</div>
      </div>
      <div class="xp-metric">
        <div class="xp-metric-label">Quota Left</div>
        <div class="xp-metric-val num">${res.remaining_quota}</div>
      </div>
      <div class="xp-metric">
        <div class="xp-metric-label">Time</div>
        <div class="xp-metric-val num">${res.elapsed_ms} ms</div>
      </div>`;
    showToast(
      `200 orders tested: ${res.created} sold, ${res.conflicts} rejected, 0 oversold`,
      'ok'
    );
    el('statusMsg').textContent = `200x test finished in ${res.elapsed_ms} ms`;
    await refreshAll();
  } catch (err) {
    showToast(esc(err.message), 'error');
  } finally {
    btn.disabled = false;
  }
}

function updateTrayClock() {
  el('trayClock').textContent = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function init() {
  const defaultDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  defaultDate.setMinutes(0, 0, 0);
  el('evDate').value = new Date(
    defaultDate.getTime() - defaultDate.getTimezoneOffset() * 60000
  )
    .toISOString()
    .slice(0, 16);

  el('buyerInput').value = state.buyerId;
  el('statusMsg').textContent = `Active user: ${state.buyerId}`;

  el('buyerInput').addEventListener('change', (e) => switchBuyer(e.target.value));
  el('buyerInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      switchBuyer(e.target.value);
    }
  });

  document.querySelectorAll('.xp-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  el('toast').addEventListener('click', (e) => {
    const jump = e.target.closest('[data-jump-tab]');
    if (jump) switchTab(jump.dataset.jumpTab);
  });
  el('toastClose').addEventListener('click', () => showToast(''));

  el('eventsContainer').addEventListener('click', (e) => {
    const buyBtn = e.target.closest('button[data-buy-tier]');
    if (buyBtn) {
      openBookDialog(buyBtn.dataset.buyEvent, buyBtn.dataset.buyTier);
      return;
    }
    const emptyBtn = e.target.closest('button[data-empty-action]');
    if (emptyBtn && emptyBtn.dataset.emptyAction === 'new') {
      el('eventDialog').showModal();
    } else if (emptyBtn && emptyBtn.dataset.emptyAction === 'seed') {
      seedSampleEvent();
    }
  });

  el('qtyButtons').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-qty]');
    if (!btn) return;
    state.bookQty = Number(btn.dataset.qty);
    updateQtyUi();
  });

  el('bookForm').addEventListener('submit', handleBookSubmit);
  el('closeBookDialogBtn').addEventListener('click', () => el('bookDialog').close());
  el('cancelBookBtn').addEventListener('click', () => el('bookDialog').close());

  el('openNewEventBtn').addEventListener('click', () => el('eventDialog').showModal());
  el('eventForm').addEventListener('submit', handleCreateEvent);
  el('closeEventDialogBtn').addEventListener('click', () => el('eventDialog').close());
  el('cancelEventBtn').addEventListener('click', () => el('eventDialog').close());

  el('ordersTbody').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-order-action]');
    if (!btn) return;
    handleOrderAction(btn.dataset.orderAction, btn.dataset.id);
  });

  el('runBurstBtn').addEventListener('click', handleBurstDemo);
  el('refreshLabBtn').addEventListener('click', refreshAll);

  el('minBtn').addEventListener('click', () => {
    el('appWindow').classList.add('minimized');
    el('taskWindowBtn').classList.remove('active');
  });

  el('maxBtn').addEventListener('click', () => {
    const win = el('appWindow');
    win.classList.remove('minimized');
    win.classList.toggle('maximized');
    el('taskWindowBtn').classList.add('active');
  });

  el('taskWindowBtn').addEventListener('click', () => {
    const win = el('appWindow');
    const minimized = win.classList.toggle('minimized');
    el('taskWindowBtn').classList.toggle('active', !minimized);
  });

  updateTrayClock();
  setInterval(updateTrayClock, 15000);

  setInterval(() => {
    let anyExpired = false;
    document.querySelectorAll('.xp-countdown[data-expires]').forEach((cell) => {
      const text = formatCountdown(cell.dataset.expires);
      cell.textContent = text;
      if (text === '00:00') anyExpired = true;
    });
    if (anyExpired && !state.expiryRefreshSent) {
      state.expiryRefreshSent = true;
      refreshAll();
    }
  }, 1000);

  refreshAll();
}

init();
