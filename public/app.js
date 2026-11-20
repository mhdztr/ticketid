'use strict';

const state = {
  buyerId: localStorage.getItem('ticketid_buyer') || 'buyer-01',
  events: [],
  selectedEventId: null,
  selectedTierId: null,
  orders: [],
  tickets: [],
  webhooks: [],
  activeTab: 'orders',
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
  const d = new Date(iso);
  return d.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCountdown(expiresIso) {
  const diffSec = Math.floor((new Date(expiresIso).getTime() - Date.now()) / 1000);
  if (diffSec <= 0) return '00:00';
  const mins = String(Math.floor(diffSec / 60)).padStart(2, '0');
  const secs = String(diffSec % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

function setStatus(text) {
  el('statusMsg').textContent = text;
}

function showNotice(targetId, message, kind) {
  const box = el(targetId);
  if (!message) {
    box.hidden = true;
    box.textContent = '';
    box.className = 'xp-notice';
    return;
  }
  box.hidden = false;
  box.textContent = message;
  box.className = `xp-notice ${kind || ''}`.trim();
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

function getSelectedEvent() {
  return state.events.find((ev) => ev.id === state.selectedEventId) || null;
}

function renderEvents() {
  const tbody = el('eventsTbody');
  el('eventCountLabel').textContent = `${state.events.length} events loaded`;

  if (state.events.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="4" class="xp-empty">No events yet. Seed a sample event or create one</td></tr>';
    renderSelectedEvent();
    return;
  }

  if (!getSelectedEvent()) {
    state.selectedEventId = state.events[0].id;
  }

  tbody.innerHTML = state.events
    .map((ev) => {
      const reg = ev.ticket_types.find((t) => t.category === 'REGULER');
      const vip = ev.ticket_types.find((t) => t.category === 'VIP');
      const selected = ev.id === state.selectedEventId ? 'selected' : '';
      return `
        <tr data-event-id="${esc(ev.id)}" class="${selected}">
          <td><strong>${esc(ev.title)}</strong><div class="xp-muted">${esc(ev.venue)}</div></td>
          <td class="num">${esc(formatDate(ev.event_date))}</td>
          <td class="num">${reg ? `${reg.available_quota}/${reg.total_quota}` : '-'}</td>
          <td class="num">${vip ? `${vip.available_quota}/${vip.total_quota}` : '-'}</td>
        </tr>`;
    })
    .join('');

  renderSelectedEvent();
}

function renderSelectedEvent() {
  const box = el('selectedEventBox');
  const radios = el('tierRadios');
  const reserveBtn = el('reserveBtn');
  const ev = getSelectedEvent();

  if (!ev) {
    box.innerHTML = '<div class="xp-muted">Select an event to inspect remaining quotas</div>';
    radios.innerHTML = '<div class="xp-muted">No event selected</div>';
    reserveBtn.disabled = true;
    updateBookingTotal();
    return;
  }

  const tiersHtml = ev.ticket_types
    .map((tt) => {
      const pct = tt.total_quota > 0 ? Math.round((tt.available_quota / tt.total_quota) * 100) : 0;
      return `
        <div class="xp-tier-row">
          <div class="xp-tier-head">
            <span><strong>${esc(tt.category)}</strong> - ${esc(formatIdr(tt.price))}</span>
            <span class="num">${tt.available_quota} / ${tt.total_quota} left</span>
          </div>
          <div class="xp-progress" aria-label="${esc(tt.category)} quota bar">
            <div class="xp-progress-fill" style="width: ${pct}%"></div>
          </div>
        </div>`;
    })
    .join('');

  box.innerHTML = `
    <div class="xp-quota-title">${esc(ev.title)}</div>
    <div class="xp-quota-meta">${esc(ev.venue)} | ${esc(formatDate(ev.event_date))}</div>
    ${tiersHtml}`;

  if (!ev.ticket_types.some((t) => t.id === state.selectedTierId)) {
    state.selectedTierId = ev.ticket_types[0] ? ev.ticket_types[0].id : null;
  }

  radios.innerHTML = ev.ticket_types
    .map((tt) => {
      const checked = tt.id === state.selectedTierId ? 'checked' : '';
      return `
        <label class="xp-radio-opt">
          <span class="xp-radio-opt-left">
            <input type="radio" name="tierChoice" value="${esc(tt.id)}" ${checked} />
            <strong>${esc(tt.category)}</strong>
            <span class="xp-muted">(${tt.available_quota} left)</span>
          </span>
          <span class="num">${esc(formatIdr(tt.price))}</span>
        </label>`;
    })
    .join('');

  reserveBtn.disabled = !state.selectedTierId;
  updateBookingTotal();
}

function updateBookingTotal() {
  const ev = getSelectedEvent();
  const tier = ev && ev.ticket_types.find((t) => t.id === state.selectedTierId);
  const qty = Number(el('bookQty').value || 1);
  el('bookTotal').textContent = tier ? formatIdr(tier.price * qty) : 'Rp 0';
}

function statusBadge(status) {
  const map = {
    PENDING: 'xp-badge-pending',
    PAID: 'xp-badge-paid',
    CANCELLED: 'xp-badge-cancelled',
    EXPIRED: 'xp-badge-expired',
  };
  return `<span class="xp-badge ${map[status] || ''}">${esc(status)}</span>`;
}

function renderOrders() {
  const tbody = el('ordersTbody');
  el('tabOrdersBtn').textContent = `Orders (${state.orders.length})`;
  el('statusCounts').textContent = `Events: ${state.events.length} | Orders: ${state.orders.length}`;

  if (state.orders.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="xp-empty">No orders found for this buyer</td></tr>';
    return;
  }

  tbody.innerHTML = state.orders
    .map((ord) => {
      const countdown = ord.status === 'PENDING' ? formatCountdown(ord.expires_at) : '-';
      let actions = '';
      if (ord.status === 'PENDING') {
        actions = `
          <button type="button" class="xp-btn xp-btn-small" data-order-action="pay" data-id="${esc(ord.id)}">Pay Webhook</button>
          <button type="button" class="xp-btn xp-btn-small" data-order-action="cancel" data-id="${esc(ord.id)}">Cancel</button>
          <button type="button" class="xp-btn xp-btn-small" data-order-action="late" data-id="${esc(ord.id)}">Late Webhook</button>`;
      } else if (ord.status === 'PAID') {
        actions = `
          <button type="button" class="xp-btn xp-btn-small" data-order-action="duplicate" data-id="${esc(ord.id)}">Duplicate Webhook</button>`;
      } else {
        actions = `
          <button type="button" class="xp-btn xp-btn-small" data-order-action="late" data-id="${esc(ord.id)}">Late Webhook</button>`;
      }

      return `
        <tr>
          <td class="mono">${esc(ord.order_code)}</td>
          <td>${esc(ord.event_title)}</td>
          <td>${esc(ord.ticket_category)}</td>
          <td class="num">${ord.quantity}</td>
          <td class="num">${esc(formatIdr(ord.total_price))}</td>
          <td>${statusBadge(ord.status)}</td>
          <td class="num countdown" data-expires="${ord.status === 'PENDING' ? esc(ord.expires_at) : ''}">${esc(countdown)}</td>
          <td><div class="xp-actions-cell">${actions}</div></td>
        </tr>`;
    })
    .join('');
}

function renderTickets() {
  const list = el('ticketsList');
  el('tabTicketsBtn').textContent = `Issued Tickets (${state.tickets.length})`;

  if (state.tickets.length === 0) {
    list.innerHTML =
      '<div class="xp-empty">No tickets issued yet. Complete payment via webhook to issue ticket codes</div>';
    return;
  }

  list.innerHTML = state.tickets
    .map(
      (t) => `
      <div class="ticket-slip">
        <div class="ticket-stub">
          <div>
            <span class="xp-badge xp-badge-paid">${esc(t.category)}</span>
            <span class="xp-muted" style="margin-left: 4px">Seat #${t.seat_seq}</span>
          </div>
          <div class="ticket-code">${esc(t.ticket_code)}</div>
          <div class="xp-muted mono">${esc(t.order_code)}</div>
        </div>
        <div class="ticket-body">
          <strong>${esc(t.event_title)}</strong>
          <div>${esc(t.venue)}</div>
          <div class="xp-muted">Event: ${esc(formatDate(t.event_date))}</div>
          <div class="xp-muted">Issued: ${esc(formatDate(t.issued_at))}</div>
        </div>
      </div>`
    )
    .join('');
}

function renderWebhooks() {
  const tbody = el('webhooksTbody');
  if (state.webhooks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="xp-empty">No webhook deliveries logged</td></tr>';
    return;
  }

  tbody.innerHTML = state.webhooks
    .map(
      (wh) => `
      <tr>
        <td class="num">${esc(formatDate(wh.processed_at))}</td>
        <td class="mono">${esc(wh.webhook_id)}</td>
        <td class="mono">${esc(wh.order_id.slice(0, 8))}...</td>
        <td>${esc(wh.provider_status)}</td>
        <td class="mono">${esc(wh.resolution)}</td>
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

    el('healthBadge').textContent = `API ${health.status.toUpperCase()} | DB ${health.db.toUpperCase()}`;
    el('statusDb').textContent = `DB: ${health.db === 'up' ? 'PostgreSQL OK' : 'Down'}`;
    state.events = evData.events || [];
    state.orders = ordData.orders || [];
    state.tickets = tktData.tickets || [];
    state.webhooks = whData.webhooks || [];
    state.expiryRefreshSent = false;

    renderEvents();
    renderOrders();
    renderTickets();
    renderWebhooks();
  } catch (err) {
    el('healthBadge').textContent = 'API Error';
    el('statusDb').textContent = 'DB: Error';
    setStatus(err.message);
  }
}

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.xp-tab').forEach((btn) => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.xp-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.id === `pane-${tabName}`);
  });
}

function setBuyer(newBuyer) {
  const clean = newBuyer.trim();
  if (!clean) return;
  state.buyerId = clean;
  localStorage.setItem('ticketid_buyer', clean);
  el('buyerInput').value = clean;
  if (['buyer-01', 'buyer-02', 'buyer-03'].includes(clean)) {
    el('buyerPreset').value = clean;
  }
  el('statusBuyer').textContent = `Buyer: ${clean}`;
  showNotice('bookNotice', '');
  showNotice('orderNotice', '');
  setStatus(`Switched active buyer to ${clean}`);
  refreshAll();
}

async function seedSampleEvent() {
  setStatus('Seeding sample event...');
  try {
    const event = await api('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        title: `Indie Night #${Math.floor(100 + Math.random() * 900)}`,
        description: 'Sample event created from BoxOffice console',
        venue: 'Hall A Jakarta',
        event_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        ticket_types: [
          { category: 'REGULER', price: 150000, quota: 10 },
          { category: 'VIP', price: 350000, quota: 5 },
        ],
      }),
    });
    state.selectedEventId = event.id;
    state.selectedTierId = null;
    await refreshAll();
    setStatus(`Created sample event ${event.title}`);
  } catch (err) {
    setStatus(err.message);
  }
}

async function handleReserve(e) {
  e.preventDefault();
  if (!state.selectedTierId) return;
  const qty = Number(el('bookQty').value || 1);
  showNotice('bookNotice', '');
  setStatus('Reserving tickets...');

  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ ticket_type_id: state.selectedTierId, quantity: qty }),
    });
    showNotice(
      'bookNotice',
      `Reserved ${order.order_code} (${order.quantity}x ${order.ticket_category}). Hold expires in 15 minutes`,
      'ok'
    );
    setStatus(`Order ${order.order_code} created (PENDING)`);
    await refreshAll();
  } catch (err) {
    showNotice('bookNotice', `${err.code || 'ERROR'}: ${err.message}`, 'error');
    setStatus(`Reservation failed: ${err.message}`);
  }
}

async function handleOrderAction(action, orderId) {
  showNotice('orderNotice', '');
  try {
    if (action === 'cancel') {
      const res = await api(`/api/orders/${orderId}/cancel`, { method: 'POST' });
      showNotice(
        'orderNotice',
        `Order ${res.order_code} cancelled and quota returned`,
        'ok'
      );
      setStatus(`Cancelled order ${res.order_code}`);
    } else if (action === 'pay') {
      const res = await api('/api/payments/simulate', {
        method: 'POST',
        body: JSON.stringify({ order_id: orderId, mode: 'normal' }),
      });
      showNotice(
        'orderNotice',
        `Webhook ${res.webhook_id} resolved: ${res.resolution} (${res.tickets.length} ticket issued)`,
        'ok'
      );
      setStatus(`Payment settled (${res.resolution})`);
    } else if (action === 'duplicate') {
      const res = await api('/api/payments/simulate', {
        method: 'POST',
        body: JSON.stringify({ order_id: orderId, mode: 'duplicate' }),
      });
      showNotice(
        'orderNotice',
        `Duplicate replay: 1st=${res.first.resolution} (replay=${res.first.idempotent_replay}), 2nd=${res.second.resolution} (replay=${res.second.idempotent_replay}), tickets=${res.second.tickets.length}`,
        'ok'
      );
      setStatus('Verified idempotent duplicate webhook');
    } else if (action === 'late') {
      const res = await api('/api/payments/simulate', {
        method: 'POST',
        body: JSON.stringify({ order_id: orderId, mode: 'late' }),
      });
      showNotice(
        'orderNotice',
        `Late webhook ${res.webhook_id}: order=${res.order_status}, resolution=${res.resolution}, refund_required=${res.refund_required}`,
        'error'
      );
      setStatus(`Late payment logged (${res.resolution})`);
    }
    await refreshAll();
  } catch (err) {
    showNotice('orderNotice', `${err.code || 'ERROR'}: ${err.message}`, 'error');
    setStatus(err.message);
    await refreshAll();
  }
}

async function handleCreateEvent(e) {
  e.preventDefault();
  showNotice('createNotice', '');
  const rawDate = el('evDate').value;
  if (!rawDate) return;

  try {
    const created = await api('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        title: el('evTitle').value.trim(),
        description: el('evDesc').value.trim(),
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
    state.selectedEventId = created.id;
    state.selectedTierId = null;
    showNotice('createNotice', `Created event "${created.title}"`, 'ok');
    setStatus(`Created event ${created.title}`);
    await refreshAll();
  } catch (err) {
    showNotice('createNotice', `${err.code || 'ERROR'}: ${err.message}`, 'error');
    setStatus(err.message);
  }
}

async function handleBurstDemo() {
  const btn = el('runBurstBtn');
  btn.disabled = true;
  setStatus('Running 200 concurrent reservations against 100 quota...');
  try {
    const res = await api('/api/payments/concurrency-demo', { method: 'POST' });
    el('burstResult').innerHTML = `
      <div class="xp-metric-cell">
        <div class="xp-metric-label">Total Requests / Quota</div>
        <div class="xp-metric-value num">${res.total_requests} / ${res.quota}</div>
      </div>
      <div class="xp-metric-cell">
        <div class="xp-metric-label">201 Created / 409 Sold Out / Other</div>
        <div class="xp-metric-value num">${res.created} / ${res.conflicts} / ${res.other}</div>
      </div>
      <div class="xp-metric-cell">
        <div class="xp-metric-label">Remaining Quota / Elapsed</div>
        <div class="xp-metric-value num">${res.remaining_quota} / ${res.elapsed_ms} ms</div>
      </div>`;
    state.selectedEventId = res.event_id;
    await refreshAll();
    setStatus(
      `Burst complete: ${res.created} reserved, ${res.conflicts} rejected, 0 oversold (${res.elapsed_ms} ms)`
    );
  } catch (err) {
    setStatus(`Burst failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

function updateTrayClock() {
  const now = new Date();
  el('trayClock').textContent = now.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function init() {
  const defaultEventDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  defaultEventDate.setMinutes(0, 0, 0);
  const localIso = new Date(
    defaultEventDate.getTime() - defaultEventDate.getTimezoneOffset() * 60000
  )
    .toISOString()
    .slice(0, 16);
  el('evDate').value = localIso;

  el('buyerInput').value = state.buyerId;
  if (['buyer-01', 'buyer-02', 'buyer-03'].includes(state.buyerId)) {
    el('buyerPreset').value = state.buyerId;
  }
  el('statusBuyer').textContent = `Buyer: ${state.buyerId}`;

  el('buyerPreset').addEventListener('change', (e) => setBuyer(e.target.value));
  el('switchBuyerBtn').addEventListener('click', () => setBuyer(el('buyerInput').value));
  el('buyerInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setBuyer(el('buyerInput').value);
    }
  });
  el('refreshBtn').addEventListener('click', refreshAll);
  el('refreshLogsBtn').addEventListener('click', refreshAll);
  el('seedEventBtn').addEventListener('click', seedSampleEvent);
  el('bookForm').addEventListener('submit', handleReserve);
  el('bookQty').addEventListener('change', updateBookingTotal);
  el('createEventForm').addEventListener('submit', handleCreateEvent);
  el('runBurstBtn').addEventListener('click', handleBurstDemo);

  el('eventsTbody').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-event-id]');
    if (!row) return;
    state.selectedEventId = row.dataset.eventId;
    state.selectedTierId = null;
    renderEvents();
  });

  el('tierRadios').addEventListener('change', (e) => {
    if (e.target.name === 'tierChoice') {
      state.selectedTierId = e.target.value;
      updateBookingTotal();
    }
  });

  el('ordersTbody').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-order-action]');
    if (!btn) return;
    handleOrderAction(btn.dataset.orderAction, btn.dataset.id);
  });

  document.querySelectorAll('.xp-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

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

  const startBtn = el('startBtn');
  const startMenu = el('startMenu');
  startBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = startMenu.classList.toggle('open');
    startBtn.setAttribute('aria-expanded', String(open));
  });

  startMenu.addEventListener('click', (e) => {
    const item = e.target.closest('button');
    if (!item) return;
    startMenu.classList.remove('open');
    startBtn.setAttribute('aria-expanded', 'false');
    el('appWindow').classList.remove('minimized');
    el('taskWindowBtn').classList.add('active');
    if (item.dataset.startTab) {
      switchTab(item.dataset.startTab);
    } else if (item.dataset.startAction === 'seed') {
      seedSampleEvent();
    } else if (item.dataset.startAction === 'refresh') {
      refreshAll();
    }
  });

  document.addEventListener('click', () => {
    startMenu.classList.remove('open');
    startBtn.setAttribute('aria-expanded', 'false');
  });

  updateTrayClock();
  setInterval(updateTrayClock, 15000);

  setInterval(() => {
    let anyExpired = false;
    document.querySelectorAll('.countdown[data-expires]').forEach((cell) => {
      if (!cell.dataset.expires) return;
      const text = formatCountdown(cell.dataset.expires);
      cell.textContent = text;
      if (text === '00:00') {
        anyExpired = true;
      }
    });
    if (anyExpired && !state.expiryRefreshSent) {
      state.expiryRefreshSent = true;
      refreshAll();
    }
  }, 1000);

  refreshAll();
}

init();
