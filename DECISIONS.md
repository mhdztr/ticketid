# Catatan Keputusan Arsitektur (Architecture Decisions)

Dokumen ini merangkum keputusan teknis utama pada **TicketID**, alasan pemilihannya untuk skala kasus penjualan tiket kuota terbatas, alternatif yang tidak diambil, serta trade-off yang menyertainya.

---

## 1. Express 5 + TypeScript + `pg` Raw SQL (Tanpa ORM Berat)

- **Keputusan**: Menggunakan Node.js + TypeScript dengan Express 5, driver `pg` (`node-postgres`) langsung dengan parameterized SQL, dan Zod untuk validasi input di layer route.
- **Alasan**:
  - Kontrol penuh atas transaksi ACID (`BEGIN` / `COMMIT` / `ROLLBACK`), klausa `FOR UPDATE`, `FOR UPDATE SKIP LOCKED`, serta atomic conditional update (`UPDATE ... WHERE available_quota >= $1 RETURNING ...`) tanpa perlu menebak SQL apa yang dihasilkan ORM.
  - Struktur proyek tetap datar dan mudah ditelusuri (`routes/` → `services/` → `db.ts`) tanpa lapisan repository abstrak atau factory berlebihan.
- **Alternatif yang tidak dipilih**:
  - *Prisma ORM*: nyaman untuk CRUD standar, tetapi untuk query locking spesifik (`FOR UPDATE SKIP LOCKED`, partial index update, agregasi batch terurut) ujung-ujungnya tetap harus turun ke `$queryRaw`. Memakai `pg` langsung membuat kode transaksi lebih transparan dan membuang overhead binary engine di container.
- **Trade-off**:
  - Skema tabel (`db/schema.sql`) dan mapping tipe (misalnya mengonversi `BIGINT` dari string PostgreSQL ke `number`) ditulis manual, sehingga perlu teliti saat migrasi kolom bertambah. Untuk skala aplikasi kecil dengan 6 tabel, ini masih sangat terkendali.

---

## 2. PostgreSQL sebagai Single Source of Truth (Bukan Redis / SQLite)

- **Keputusan**: Seluruh data event, sisa kuota, batas pembeli, pesanan, tiket, dan audit webhook disimpan di satu instance PostgreSQL 16.
- **Alasan**:
  - Data kuota (`ticket_types.available_quota`), batas per pembeli (`buyer_event_quotas`), dan status pesanan (`orders.status`) wajib konsisten bersama secara transaksional (*all-or-nothing*). Jika kuota dikurangi, pesanan harus tercatat; jika pembuatan pesanan gagal, kuota tidak boleh berkurang.
  - PostgreSQL memberi constraint fisik (`CHECK`, `UNIQUE`, `PRIMARY KEY`) sebagai jaring pengaman terakhir di level database.
- **Alternatif yang tidak dipilih**:
  - *Redis sebagai primary quota counter*: memisahkan penyimpanan kuota (Redis) dan transaksi pesanan/tiket (PostgreSQL) memunculkan masalah *dual-write* — jika Redis berhasil `DECR` lalu DB gagal commit atau container crash di tengah, kuota bisa bocor kecuali memakai mekanisme kompensasi/Saga. Untuk target ratusan permintaan bersamaan, connection pool PostgreSQL sudah jauh lebih dari cukup.
  - *SQLite*: menggunakan file-level write lock sehingga 200 transaksi tulis bersamaan rentan memicu error `SQLITE_BUSY` dan sulit mensimulasikan row-level locking.
  - *Microservice + Message Broker*: melampaui kebutuhan tugas ("tidak ada microservice") dan menambah titik kegagalan operasional.
- **Trade-off**:
  - Throughput puncak terikat oleh satu node PostgreSQL (dan ukuran pool `max: 30` pada `src/db.ts`). Jika suatu saat traffic meningkat ke flash sale puluhan ribu request per detik, arsitektur perlu ditambah waiting room / antrean Redis + rate limiting di depan database.

---

## 3. Anti-Oversell Kuota: Atomic Conditional Update + `CHECK` Constraint

- **Keputusan**: Pengurangan kuota saat memesan dilakukan langsung dalam satu query atomik di dalam transaksi (`src/services/orderService.ts`):
  ```sql
  UPDATE ticket_types
  SET available_quota = available_quota - $1
  WHERE id = $2 AND available_quota >= $1
  RETURNING available_quota;
  ```
  Ditambah constraint tabel `CHECK (available_quota >= 0 AND available_quota <= total_quota)`.
- **Alasan**:
  - Pada isolation level default PostgreSQL (`READ COMMITTED`), dua transaksi yang meng-update baris `ticket_types` yang sama otomatis diantrekan oleh row lock hingga transaksi pertama selesai (`COMMIT` atau `ROLLBACK`). Transaksi kedua otomatis mengevaluasi kondisi `available_quota >= $1` terhadap nilai terbaru yang sudah di-commit.
  - Tidak ada celah *check-then-act* seperti pola `SELECT available_quota` lalu `UPDATE` di kode aplikasi.
- **Alternatif yang tidak dipilih**:
  - *In-memory lock / queue di Node.js*: langsung gagal jika API dijalankan lebih dari 1 proses/replika atau jika ada background sweeper terpisah yang juga mengubah kuota.
  - *Optimistic locking (`version` column + retry loop)*: pada kasus *hot row* seperti 200 orang berebut 100 tiket yang sama, hampir semua transaksi di ronde pertama gagal validasi `version` dan melakukan *retry storm*, membuang CPU dan koneksi database.
  - *Isolation level `SERIALIZABLE`*: aman, tetapi menimbulkan `40001 serialization_failure` yang mewajibkan retry loop generik di seluruh endpoint transaksi.
- **Trade-off**:
  - Request ke tipe tiket yang sama akan mengantri sebentar di row lock PostgreSQL, namun karena satu transaksi pemesanan hanya menjalankan beberapa query mikro (<5 ms), 200 request paralel tetap selesai dalam ~330 ms dengan tepat 100 sukses dan 100 ditolak (`409 INSUFFICIENT_QUOTA`).

---

## 4. Menjaga Batas 4 Tiket per Pembeli: Tabel `buyer_event_quotas` & Lock-Ordering DAG

- **Konteks Masalah (*Write Skew*)**: Batas maksimal 4 tiket berlaku untuk total pesanan `PENDING` + `PAID` milik satu pembeli pada satu event, termasuk gabungan antara tiket `REGULER` dan `VIP`. Jika kita hanya mengunci baris `ticket_types` lalu menjalankan `SELECT SUM(quantity) FROM orders`, dua request paralel dari pembeli yang sama (misal beli 3 `REGULER` dan 3 `VIP`) akan mengunci baris `ticket_types` yang berbeda, sama-sama melihat `SUM = 0`, dan meloloskan total **6 tiket**.
- **Keputusan**:
  - Menyimpan counter agregat per `(event_id, buyer_id)` di tabel `buyer_event_quotas` dengan `PRIMARY KEY (event_id, buyer_id)` dan `CHECK (active_tickets >= 0 AND active_tickets <= 4)`.
  - Di dalam `tryCreateOrder`, transaksi lebih dulu melakukan `INSERT ... ON CONFLICT DO NOTHING` diikuti update kondisional atomik `SET active_tickets = active_tickets + $3 WHERE ... AND active_tickets + $3 <= $4`, baru kemudian mengurangi `ticket_types.available_quota`.
- **Urutan Lock Anti-Deadlock (DAG)**:
  - Jalur **Buat Pesanan**: `buyer_event_quotas` → `ticket_types` → `INSERT orders (baris baru)`.
  - Jalur **Cancel / Expire / Webhook**: `orders (baris lama)` → `buyer_event_quotas` → `ticket_types`.
  - Karena jalur pembuatan pesanan tidak pernah mengunci baris `orders` yang sudah ada dan jalur mutasi selalu mengunci `buyer_event_quotas` sebelum `ticket_types` (serta diurutkan leksikografis pada batch sweeper), tidak ada siklus ketergantungan lock sehingga deadlock terhindar secara struktural.
- **Alternatif yang tidak dipilih**:
  - *`SELECT SUM(quantity) FROM orders` tanpa lock per pembeli*: rentan write skew saat pembeli mengirim dua request paralel ke kategori berbeda.
  - *`pg_advisory_xact_lock` saja*: bisa memblokir paralelisme per pembeli, tetapi tidak menyediakan constraint fisik `CHECK (active_tickets <= 4)` di level tabel.
- **Trade-off**:
  - Menambah 1 tabel counter yang harus selalu dijaga sinkronisasi decrement-nya saat pesanan `CANCELLED` atau `EXPIRED` melalui helper terpusat `releaseOrderQuota()`.

---

## 5. Kedaluwarsa Pesanan 15 Menit: Hybrid Worker (`SKIP LOCKED`) + Lazy Guard

- **Keputusan**: Menggunakan kombinasi dua lapis:
  1. **Background Sweeper** (`src/workers/expiryWorker.ts` + `expirePendingOrders` di `src/services/orderService.ts`) berjalan periodik (default 3 detik) menggunakan partial index `idx_orders_pending_expires ON orders (expires_at) WHERE status = 'PENDING'` dan `FOR UPDATE SKIP LOCKED`.
  2. **Lazy Expiry Guard**: fungsi baca (`listEvents`, `getEventById`, `listOrdersByBuyer`, `getOrderById`) dan mutasi (`cancelOrder`, `processPaymentWebhook`, serta retry otomatis di `createOrder` saat tertahan `INSUFFICIENT_QUOTA`/`BUYER_LIMIT_EXCEEDED`) memeriksa/mengekspirasi pesanan yang sudah melewati `expires_at`.
- **Alasan**:
  - `FOR UPDATE SKIP LOCKED` memastikan jika beberapa proses/lazy trigger berjalan bersamaan, masing-masing melewati baris yang sedang diproses transaksi lain — tidak ada pemblokiran dan mustahil mengembalikan kuota dua kali.
  - Pengembalian kuota agregat di `expirePendingOrders` selalu mengecek `WHERE status = 'PENDING'` saat update status dan mengurutkan ID kunci yang diperbarui agar bebas deadlock.
  - Menyuntikkan `clock` (`src/clock.ts`) dan `ORDER_TTL_SECONDS` membuat seluruh skenario 15 menit dapat diuji deterministik dalam hitungan milidetik di unit/integration test.
- **Alternatif yang tidak dipilih**:
  - *Pure lazy expiry (tanpa background worker)*: jika tidak ada yang membuka katalog atau memesan, pesanan hangus bertahan sebagai `PENDING` dan sisa kuota tampak kosong padahal sudah lewat 15 menit.
  - *OS Cron (`crontab`)*: resolusi minimum 1 menit terlalu kasar untuk demo dan menambah dependensi di container Alpine.
  - *In-memory `setTimeout`*: timer 15 menit hilang seketika jika container restart atau crash.
  - *Delayed job queue eksternal (BullMQ/RabbitMQ)*: menambah service Redis/broker baru yang tidak diperlukan untuk volume tugas ini.
- **Trade-off**:
  - Saat ada jeda sepi, worker melakukan polling ringan ke indeks parsial setiap 3 detik; karena indeks hanya menyimpan baris `status = 'PENDING'`, ukurannya tetap kecil meskipun histori pesanan sudah besar.

---

## 6. Webhook Pembayaran: HMAC-SHA256, Idempotent Inbox, dan Kebijakan Late Payment

- **Keputusan**:
  - Menangkap raw payload bytes di middleware `express.json({ verify })` (`src/app.ts`) lalu memverifikasi header `X-Webhook-Signature` dengan `crypto.timingSafeEqual` (`src/services/paymentService.ts`).
  - Mengunci baris `orders` (`SELECT ... FOR UPDATE`) terlebih dahulu sebelum mengecek tabel `payment_webhooks (webhook_id UNIQUE)`.
  - Seluruh kasus valid (normal, duplicate replay dengan `webhook_id` sama atau beda, maupun terlambat setelah order kedaluwarsa/dibatalkan) dibalas HTTP `200 OK` beserta status `resolution` yang jelas.
- **Alasan**:
  - Mengunci baris `orders` sebelum mengecek `payment_webhooks` mencegah race condition saat provider mengirim 5 request webhook identik secara bersamaan (tanpa `orders` lock, dua worker paralel bisa sama-sama lolos cek `SELECT` dan bentrok `23505` saat `INSERT`).
  - Jika webhook `PAID` tiba setelah pesanan lewat 15 menit (`EXPIRED`) atau dibatalkan (`CANCELLED`), kuota tersebut mungkin sudah dikembalikan dan dibeli orang lain. Memaksa pesanan tetap `PAID` akan menyebabkan **oversell**. Oleh karena itu sistem mencatat `LATE_EXPIRED_NEEDS_REFUND` / `CANCELLED_NEEDS_REFUND` pada `payment_webhooks` tanpa menerbitkan tiket.
  - Mengembalikan HTTP `200 OK` memberi sinyal ke gateway pembayaran bahwa notifikasi sudah diterima dan dicatat sehingga gateway berhenti melakukan retry berjam-jam.
- **Trade-off**:
  - Alur refund ke penyedia pembayaran tidak dieksekusi otomatis karena gateway pembayaran masih disimulasikan; tindak lanjut refund mengandalkan data audit pada `payment_webhooks` (`resolution LIKE '%NEEDS_REFUND'`).

---

## 7. Penerbitan Kode Tiket Unik & Exactly-Once Issuance

- **Keputusan**:
  - Setiap kursi pada pesanan yang lunas mendapat kode acak CSPRNG (`crypto.randomBytes`) berawalan `TKT-` dengan alfabet base32 tanpa karakter ambigu (`0/O/1/I`) di `src/codes.ts`.
  - Di database, tabel `tickets` memiliki `UNIQUE (order_id, seat_seq)` dengan `seat_seq` bernomor `1..quantity` dan `ticket_code UNIQUE`.
- **Alasan**:
  - Kode acak tidak dapat ditebak atau di-enumerate seperti integer berurutan (`TKT-0001`).
  - Bahkan seandainya ada bug di lapisan aplikasi yang mencoba menerbitkan tiket kedua kalinya untuk pesanan yang sama, database akan menolaknya di constraint `UNIQUE (order_id, seat_seq)`.
- **Trade-off**:
  - Karena `TKT-` menggunakan 10 karakter acak (32^10 kemungkinan), peluang tabrakan nyaris nol untuk skala aplikasi ini, meski pada skala jutaan tiket per hari disarankan menambahkan retry-on-conflict saat insert `ticket_code`.

---

## 8. Auth Minimal (`X-Buyer-Id`), UI Klasik Tanpa Bloat, dan CI/CD Commit-SHA

- **Keputusan**:
  - Identifikasi pembeli memakai header `X-Buyer-Id` tanpa login JWT karena instruksi menyatakan autentikasi tidak dinilai.
  - UI opsional di `public/` dibangun menggunakan HTML, CSS, dan JS murni bertema Windows XP (`Express static`) tanpa build pipeline frontend tambahan agar image Docker tetap ramping dan mudah dipelihara.
  - Pipeline `.github/workflows/ci.yml` memisahkan job `test` (terhadap container Postgres 16) sebelum `build-and-push` ke `ghcr.io` dengan tag commit SHA (`sha-<short>` dan `<full-sha>`).
- **Trade-off & Batasan yang Disadari**:
  - Untuk deployment produksi nyata, header `X-Buyer-Id` harus diganti menjadi JWT/session terverifikasi agar pembeli tidak bisa mengintip/membatalkan pesanan milik `buyer_id` lain hanya dengan mengganti header.
  - `db/schema.sql` menggunakan `CREATE TABLE IF NOT EXISTS` yang cocok untuk inisialisasi awal satu perintah, namun untuk perubahan skema jangka panjang di produksi sebaiknya bermigrasi ke migration tool berversi (seperti `node-pg-migrate`).
