# EMIT Load Order Portal

Customer portal for EMIT Technologies, a shipper of Select Transport Partners. This replaces the Lovable portal at emit-select.com. It is a test deployment only: no custom domain, and the 587 existing loads are not migrated.

The app is a Next.js server. Orders, the document review queue, users, and the email outbox live in a SQLite file. A SAM TMS client is included and unit-tested, but the running app still reads and writes the mock store. SAM credentials are not available yet.

## Run locally

```bash
npm ci
cp .env.example .env.local
# Set AUTH_SECRET to a long random string before any shared deployment.
npm run dev
```

Open http://localhost:3000. With `DEMO_SEED=true` (the default outside production) the first start creates demo users and 24 clearly fake shipments.

| Who | Email | Password | Sign-in in production |
| --- | --- | --- | --- |
| EMIT staff | m.gray@emit.example | Emit-Demo-2026 | Microsoft |
| Select admin | mgray@goselect.com | Emit-Demo-2026 | Google |
| Select admin | dmartin@goselect.com | Emit-Demo-2026 | Google |
| Receiver (Enchanted Rock) | ops@enchantedrock.example | Emit-Demo-2026 | Microsoft |

EMIT staff and receivers use Microsoft. Select staff use Google (`mgray@goselect.com` and `dmartin@goselect.com` only). There is no EMIT admin role and no public signup. Password sign-in is for this demo. Production rejects it unless `DEMO_SEED=true` or `ALLOW_PASSWORD_LOGIN=true`.

The Microsoft and Google buttons explain what is missing until `AZURE_AD_*` and `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are set.

```bash
npm test
npm run typecheck
npm run build && npm start
```

## What EMIT can do

- Broker dashboard with status counts, status filter, ship-date range, search by SO or city, and pagination. A load can have any number of pickups and drops, reordered before or after it is saved.
- Create and edit a load. Submitting stores the order in the mock SAM layer and shows a confirmation that pairs the sales order with Select's load number. The same message is written to the outbox and sent by SMTP when `SMTP_HOST` and `SMTP_FROM` are set.
- Status timeline (Submitted, Booked, At Pickup, In Transit, Delivered), latest ETA, and a public tracking link.
- Ask about an SO. Answers come from the customer-safe shipment view. With no `AI_API_KEY`, a built-in answerer handles status, location, and "this week" questions.

Select admins also get the document review queue, the ship-from site list, and the receiver directory. A receiver sees only loads whose destination company matches their directory entry, and does not see EMIT's rate.

## Security boundary

Customer responses are an allowlist. Carrier pay, carrier name, MC number, and staff notes are columns the customer query never selects, and the serializer drops anything else. The assistant reads that same view. Questions about carrier pay, margins, or rate confirmations are refused before any shipment data is attached.

Every upload is split into pages and screened. A clean page is stored as a customer document. A rate confirmation, or a page the screener cannot read, stays in a separate internal store until a Select admin releases it.

The only unauthenticated route is the tracking link (`/track/[token]` and `/api/track/[token]`). It returns cities, status, timeline, and ETA. It does not return cost, comments, documents, street address, or carrier data. Demo tokens are derived from the load number and are not secrets. New orders get a random token.

See [docs/REPORT.md](docs/REPORT.md) for branding notes, deploy steps, credentials still needed, and open questions.
