# TicketID

API penjualan tiket event dengan kuota terbatas, tahan-banting terhadap pembelian bersamaan (*concurrency*), kedaluwarsa pesanan otomatis 15 menit, pembatasan kuota per pembeli, serta simulasi webhook pembayaran yang idempoten.

Proyek ini juga dilengkapi **BoxOffice Web Console** bergaya klasik Windows XP di `/` untuk mencoba seluruh alur (buat event, pesan tiket, lihat sisa kuota, trigger webhook normal/duplikat/terlambat, dan uji burst 200 request) langsung dari browser.

---

## Prasyarat

- **Docker Engine** & **Docker Compose v2** (cukup untuk menjalankan seluruh sistem dengan satu perintah)
- **Node.js 22+** *(opsional, hanya jika ingin menjalankan skrip CLI atau unit/integration test di host)*

---

## Cara Menjalankan (Satu Perintah Docker)

Dari mesin bersih yang memiliki Docker:

```bash
docker compose up --build
```

Perintah di atas otomatis menyalakan:
1. **`db`** (`postgres:16-alpine`) beserta healthcheck (`pg_isready`) dan volume persisten.
2. **`api`** (Express 5 + TypeScript + Background Expiry Worker + Static UI), yang menunggu database siap lalu menjalankan migrasi `db/schema.sql` secara idempoten.

Setelah kedua container berstatus `healthy`:
- **Web Console**: buka `http://localhost:3000`
- **Health Check**: `curl http://localhost:3000/healthz` → `{"status":"ok","db":"up"}`

> Jika port `3000` di mesin Anda sedang terpakai aplikasi lain, ganti port host tanpa mengubah kode dengan `HOST_PORT=3005 docker compose up --build`.  
> Untuk mematikan dan mereset database dari awal: `docker compose down -v`.

---

## Ringkasan Endpoint API

Identifikasi pembeli menggunakan header **`X-Buyer-Id`** (contoh: `X-Buyer-Id: buyer-01`) pada endpoint pemesanan, pembatalan, riwayat pesanan, dan tiket.

| Method | Endpoint | Header / Auth | Fungsi |
| :--- | :--- | :--- | :--- |
| `GET` | `/healthz` | - | Cek kesehatan API dan koneksi PostgreSQL |
| `POST` | `/api/events` | - | Buat event baru beserta kuota & harga `REGULER` dan `VIP` |
| `GET` | `/api/events` | - | Daftar semua event dan sisa kuota tiap tipe tiket |
| `GET` | `/api/events/:id` | - | Detail 1 event dan sisa kuota |
| `POST` | `/api/orders` | `X-Buyer-Id` | Pesan 1–4 tiket (status `PENDING`, hold 15 menit, batas 4 tiket/pembeli/event) |
| `GET` | `/api/orders` | `X-Buyer-Id` | Riwayat pesanan pembeli beserta tiket yang sudah terbit |
| `GET` | `/api/orders/:id` | `X-Buyer-Id` | Detail 1 pesanan milik pembeli |
| `POST` | `/api/orders/:id/cancel` | `X-Buyer-Id` | Batalkan pesanan `PENDING` sebelum bayar (kuota langsung kembali) |
| `GET` | `/api/tickets` | `X-Buyer-Id` | Daftar tiket milik pembeli beserta kode unik `TKT-...` |
| `POST` | `/api/webhooks/payments` | `X-Webhook-Signature` | Webhook pembayaran HMAC-SHA256 (idempoten & anti-oversell pada late payment) |
| `POST` | `/api/payments/simulate` | - | Simulator pembayaran (`normal`, `duplicate`, `late`, `failed`) |
| `GET` | `/api/payments/webhooks` | - | Log audit penerimaan webhook (filter opsional `?order_id=...`) |
| `POST` | `/api/payments/concurrency-demo` | - | Trigger uji 200 booking bersamaan terhadap 100 kuota dari Web Console |

---

## Cara Menandai Pesanan Lunas

Ada 3 cara untuk menandai pesanan berstatus `PENDING` menjadi `PAID` dan menerbitkan tiket unik:

### 1. Skrip CLI `scripts/pay.sh` (Menandatangani HMAC-SHA256)

```bash
# Pembayaran normal (menghitung HMAC-SHA256 lalu menembak POST /api/webhooks/payments)
./scripts/pay.sh <ORDER_ID>

# Uji webhook ganda dengan webhook_id & signature yang sama
./scripts/pay.sh <ORDER_ID> duplicate

# Uji webhook terlambat setelah hold 15 menit habis
./scripts/pay.sh <ORDER_ID> late

# Uji webhook status FAILED (order tetap PENDING)
./scripts/pay.sh <ORDER_ID> failed
```

Jika API dijalankan di port custom (misal `3005`), tambahkan `API_URL=http://localhost:3005 ./scripts/pay.sh <ORDER_ID>`.

### 2. Endpoint Simulator

```bash
curl -X POST http://localhost:3000/api/payments/simulate \
  -H "Content-Type: application/json" \
  -d '{"order_id":"<ORDER_ID>","mode":"normal"}'
```

Nilai `mode` yang didukung: `"normal"`, `"duplicate"`, `"late"`, atau `"failed"`.

### 3. Lewat Web Console

Buka `http://localhost:3000`, pilih tab **Orders**, lalu klik **Pay Webhook**, **Duplicate Webhook**, atau **Late Webhook** langsung di baris pesanan.

---

## Cara Menjalankan Test Otomatis & Walkthrough

### Suite Test Integrasi (Vitest + PostgreSQL)

Nyalakan database PostgreSQL terlebih dahulu, lalu jalankan seluruh test suite:

```bash
npm ci
docker compose up -d --wait db
npm run typecheck && npm run build && npm test
```

Suite test mencakup **7 file (31 test case)**:
- [health.test.ts](tests/health.test.ts): health check & verifikasi 6 tabel skema PostgreSQL.
- [events.test.ts](tests/events.test.ts): pembuatan event, cek sisa kuota `REGULER`/`VIP`, validasi payload.
- [orders.test.ts](tests/orders.test.ts): hold 15 menit, batas maksimal 4 tiket per event lintas tipe, uji *write skew* paralel `REGULER` + `VIP`, rollback saat kuota habis, cancel & double-cancel paralel, akses antar pembeli, serta *lazy expiry* saat cancel terlambat.
- [expiry.test.ts](tests/expiry.test.ts): worker kedaluwarsa (`FOR UPDATE SKIP LOCKED`), aman sebelum menit ke-15, paralel sweeper tanpa *double-release*, dan *lazy expiry* saat read/re-booking.
- [payments.test.ts](tests/payments.test.ts): verifikasi HMAC-SHA256, tolak signature invalid (`401`), 5 webhook duplikat paralel, webhook berbeda pada order yang sudah `PAID`, *late webhook* setelah 15 menit atau setelah kuota terambil pembeli lain (`LATE_EXPIRED_NEEDS_REFUND` tanpa oversell), dan `FAILED` webhook.
- [concurrency.test.ts](tests/concurrency.test.ts): uji 200 request HTTP paralel terhadap kuota 100 (kuantitas tetap `1` dan campuran `1–4`).
- [ui.test.ts](tests/ui.test.ts): static UI serving dan endpoint burst demo.

### Walkthrough End-to-End (`npm run demo`)

Saat stack Docker sudah menyala, jalankan walkthrough otomatis 9 skenario bisnis:

```bash
npm run demo
```

---

## Bukti Uji 200 Pesanan Bersamaan (Kuota 100 Tiket)

Skrip `scripts/loadtest-200.ts` membuat event dengan kuota tepat **100 tiket REGULER**, lalu melepas **200 request `POST /api/orders` secara serentak** menggunakan barrier sinkron (`Promise.all`) dari 200 pembeli berbeda (`buyer-load-001` s/d `buyer-load-200`), diikuti pembayaran webhook paralel untuk seluruh pesanan yang berhasil.

Menjalankan benchmark terhadap container Docker:

```bash
npm run loadtest
```

Output terminal aktual terhadap stack Docker (`ticketid-api-1` + `ticketid-db-1`):

```text
> ticketid@1.0.0 loadtest
> tsx scripts/loadtest-200.ts

=== TicketID 200-Concurrent Benchmark ===
Target URL            : http://localhost:3005
Event ID              : 1665bb0b-e695-4a5c-b7ad-adb88def26ac
Total Requests        : 200
Ticket Quota          : 100
201 Created           : 100
409 Conflict          : 100
Other / 5xx           : 0
Remaining Quota       : 0
Orders Paid (200 OK)  : 100
Unique Tickets Issued : 100
Booking Burst Time    : 336 ms
Webhook Settlement    : 68 ms
=======================================
```

Hasil membuktikan **0 oversell**, **0 error 5xx**, tepat **100 pesanan berhasil**, **100 ditolak (`409 Conflict`)**, sisa kuota **0**, dan **100 kode tiket unik** terbit.

---

## Pipeline CI/CD & Dependency Updates

Pipeline didefinisikan di [.github/workflows/ci.yml](.github/workflows/ci.yml) dan berjalan otomatis pada setiap `push` dan `pull_request`:
1. **Job `test`**: menyalakan service `postgres:16-alpine`, menjalankan `npm ci`, `npm run typecheck`, `npm run build`, dan seluruh `npm test`.
2. **Job `build-and-push`** (berjalan pada `push` setelah `test` lulus): build multi-stage Docker image dan push ke GitHub Container Registry (`ghcr.io/mhdztr/ticketid`) dengan tag berbasis commit SHA (`sha-<short-sha>` dan `<full-commit-sha>`), bukan hanya `latest`.
3. **Dependabot** ([.github/dependabot.yml](.github/dependabot.yml)): memantau pembaruan mingguan untuk `npm`, `docker`, dan `github-actions`.

Penjelasan rinci mengenai pilihan arsitektur, penguncian database, dan kompromi desain tersedia di [DECISIONS.md](DECISIONS.md).
