# EMIT Load Order Portal

Customer portal for EMIT Technologies, a shipper of Select Transport Partners. EMIT staff enter loads here. Select builds the load in SAM and types that load number back into the portal. The portal does not send a confirmation email and does not invent a Select load number.

The app is a Next.js server. Orders, users, and the document review queue live in Turso on Vercel, or in a local SQLite file when `TURSO_DATABASE_URL` is unset. Document and photo bytes live in Vercel Blob, or in `data/blobs` locally. A SAM TMS client is included and unit-tested. It is not called by the running app until SAM credentials exist. When they do, `syncSelectLoadNumberFromSam` in `lib/orders.ts` is the place that writes the load number SAM returned.

## Run locally

```bash
npm ci
cp .env.example .env.local
```

For a local demo, set `DEMO_SEED=true` and `NEXT_PUBLIC_DEMO_HINT=true` in `.env.local`, and set `AUTH_SECRET` to any long string. Then:

```bash
npm run dev
```

Open http://localhost:3000. The first start with `DEMO_SEED=true` creates demo users and 24 fake shipments.

| Who | Email | Password |
| --- | --- | --- |
| EMIT staff | m.gray@emit.example | Emit-Demo-2026 |
| Select admin | mgray@goselect.com | Emit-Demo-2026 |
| Select admin | dmartin@goselect.com | Emit-Demo-2026 |

`DEMO_SEED=false` does not create those users or any shipments. Production uses that setting.

EMIT staff sign in with email and password. A Select admin creates those users under Users. Select admins sign in with Google (`mgray@goselect.com` and `dmartin@goselect.com` only). Receivers do not sign in: an admin creates a private link under Settings. Microsoft sign-in can stay in the code and is off until `AZURE_AD_*` is set. It is not required.

```bash
npm test
npm run typecheck
npm run build && npm start
```

## What EMIT can do

- Broker dashboard with status counts, status filter, ship-date range, search by SO or city, and pagination. A load can have any number of pickups and drops, reordered before or after it is saved.
- Create and edit a load. Submitting stores the order and shows it on the dashboard. The Select load number stays **Pending** until a Select admin enters the number from SAM (shape `458934-1`). There is no confirmation email.
- Status timeline (Submitted, Booked, At Pickup, In Transit, Delivered), latest ETA, and a public tracking link.
- Carrier photo gallery on each load. Select admins and EMIT can view the images. An ingest API (bearer token) and the admin upload accept jpg, png, heic, and webp only. Photos attach by the real Select load number, so they wait until that number is entered.
- Ask about an SO. Answers come from the customer-safe shipment view. With no `AI_API_KEY`, a built-in answerer handles status, location, and "this week" questions.
- Change their own password under Password.

Select admins also get the document review queue, the ship-from site list, receiver companies, and EMIT users. A receiver opens a private link and sees only that company's loads, tracking, and photos. The link does not show customer cost or documents.

## Security boundary

Customer responses are an allowlist. Carrier pay is not stored in any table. The serializer still drops a carrier-pay field if one is posted, and the assistant reads that same view. Questions about carrier pay, margins, or rate confirmations are refused before any shipment data is attached.

Every upload is split into pages and screened. A clean page is stored as a customer document. A rate confirmation, or a page the screener cannot read, stays in a separate internal store. Releasing a flagged rate confirmation requires an explicit confirm and records the admin email and time. Carrier photos are a separate path: images only, deduped by hash, and a photo whose name, source, subject, or embedded text looks like a rate confirmation is kept for Select admins and is not shown to EMIT or on a receiver link.

Unauthenticated routes are the tracking link (`/track/[token]`) and a receiver's private link (`/r/[token]`). Tracking returns cities, status, timeline, and ETA. It does not return cost, comments, documents, street address, or carrier data. Demo tracking tokens are derived from the load number and are not secrets. New orders get a random token. Receiver tokens are 32 random bytes.

Password sign-in locks an email after 5 failures in 15 minutes, and an address after 20 failures in that same window. A deactivated user cannot sign in, and an existing session stops working on the next request.

See [docs/REPORT.md](docs/REPORT.md) for branding notes and earlier design notes. The go-live steps below are the ones to follow.

## Go-live checklist

Do this in the Vercel project for **Production**. Leave the SAM API and Azure unset.

1. Create the Turso database if it does not exist yet.
   - Open [https://turso.tech/app](https://turso.tech/app).
   - Create database `emit-portal` in **Washington, D.C. (iad)**.
   - Copy the `libsql://` URL and a full-access token.

2. Connect Vercel Blob.
   - Project **Storage** → **Create** → **Blob**.
   - Name it `emit-portal` and connect it to this project.
   - Vercel sets `BLOB_READ_WRITE_TOKEN`.

3. Set these Production variables. Names match `.env.example`.

   | Variable | Value |
   | --- | --- |
   | `AUTH_SECRET` | A long random string, at least 16 characters |
   | `TURSO_DATABASE_URL` | The `libsql://` URL |
   | `TURSO_AUTH_TOKEN` | The Turso token |
   | `DEMO_SEED` | `false` |
   | `NEXT_PUBLIC_DEMO_HINT` | `false` |
   | `SELECT_ADMIN_EMAILS` | `mgray@goselect.com,dmartin@goselect.com` |
   | `GOOGLE_CLIENT_ID` | Select Workspace OAuth client id |
   | `GOOGLE_CLIENT_SECRET` | That client's secret |
   | `GOOGLE_HOSTED_DOMAIN` | `goselect.com` |
   | `PORTAL_PUBLIC_URL` | The production origin, once the hostname is stable. Blank until then. |

   Do **not** set `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, `SAM_API_BASE_URL`, `SAM_API_TOKEN`, or `SAM_CUSTOMER_ID` for this launch. Do **not** set `EMAIL_FROM` or any `GMAIL_*` variable. Confirmation email has been removed. Do **not** set `ALLOW_PASSWORD_LOGIN`. Password sign-in is the normal EMIT path.

   `AI_API_KEY` and `CARRIER_PHOTO_INGEST_TOKEN` can wait.

4. Google OAuth client (Select Google Cloud, consent screen **Internal**).
   - Type: Web application.
   - Redirect URI: `{PORTAL_PUBLIC_URL}/api/auth/google/callback`
   - JavaScript origin: the origin of `PORTAL_PUBLIC_URL`
   - Scopes: `openid`, `email`, `profile`

5. Deploy Production. Open the site.
   - The login page has email and password, plus **Select staff — Google**. It does not ask EMIT to use Microsoft.
   - Sign in with Google as `mgray@goselect.com`.
   - Users should be empty. Settings → Receivers should be empty. The dashboard should have no loads.
   - Create the first EMIT user (name and email). Copy the temporary password and send it to them.
   - That person signs in, then sets their own password under Password.
   - They submit an order. Select load shows **Pending**.
   - Build the load in SAM. On the order, enter the SAM load number (for example `458934-1`) and save. EMIT then sees that number. Until you enter it, they do not see a made-up number.

6. When a hostname is final, set `PORTAL_PUBLIC_URL` to it and add that origin to the Google client. Tracking and receiver links use it.

Preview deployments may set `DEMO_SEED=true` if you still want the fake shipments there. Production must stay `DEMO_SEED=false`.
