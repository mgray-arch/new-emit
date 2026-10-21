# EMIT Load Order Portal

Customer portal for EMIT Technologies, a shipper of Select Transport Partners. It replaces the old Lovable app on **emit-select.com**.

EMIT staff sign in with email and password. Select admins sign in with Google. The portal is the order confirmation: it does not send email. There is no SAM API yet, so a Select admin types the real SAM load number onto an order after building it in SAM. Until that number is entered, EMIT sees **Pending**. The portal does not invent a load number.

Orders, users, and the document review queue live in Turso. Document and photo bytes live in Vercel Blob. Locally, with those unset, the app uses a SQLite file and `data/blobs`.

## What EMIT can do

- Broker dashboard with status counts, ship-date range, search, and pagination. A load can have any number of pickups and drops.
- Submit a load. The order appears in the portal immediately. That screen is the confirmation. No email is sent.
- See the Select load number once a Select admin has entered it. Before that, the column says Pending.
- Status timeline, latest ETA, and a public tracking link.
- Carrier photo gallery. Rate-confirmation images stay with Select admins.
- Ask about an SO. Answers come from the customer-safe shipment view.

Select admins also get the document review queue, ship-from sites, receiver companies, and the EMIT user list.

## Security boundary

Customer responses are an allowlist. Carrier pay is not stored. The serializer drops a carrier-pay field if one is posted, and the assistant reads that same view. Questions about carrier pay, margins, or rate confirmations are refused before any shipment data is attached.

Every upload is split into pages and screened. A rate confirmation, or a page the screener cannot read, stays in an internal store. Releasing a flagged rate confirmation requires an explicit confirm and records the admin email and time.

Unauthenticated routes are the tracking link (`/track/[token]`) and a receiver's private link (`/r/[token]`). Tracking returns cities, status, timeline, and ETA. It does not return cost, comments, documents, street address, or carrier data. Receiver links do not show customer cost or documents.

## Run locally

```bash
npm ci
cp .env.example .env.local
```

For a local demo, set `DEMO_SEED=true` and `NEXT_PUBLIC_DEMO_HINT=true` in `.env.local`, and set `AUTH_SECRET` to any long string. The first start creates demo users and clearly fake shipments.

| Who | Email | Password | How they sign in for real |
| --- | --- | --- | --- |
| EMIT staff | m.gray@emit.example | Emit-Demo-2026 | Email and password |
| Select admin | mgray@goselect.com | Emit-Demo-2026 | Google |
| Select admin | dmartin@goselect.com | Emit-Demo-2026 | Google |

Those passwords exist only when the demo seed runs. Production with `DEMO_SEED=false` creates nobody.

```bash
npm test
npm run typecheck
npm run dev
```

Open http://localhost:3000.

## Production environment variables

Set these on the Vercel project for **Production**. Preview can keep `DEMO_SEED=true` until you are done clicking around. Do not point the custom domain at a deployment that still has the demo seed.

| Variable | Production value |
| --- | --- |
| `AUTH_SECRET` | A long random string, at least 16 characters. Generate a new one. |
| `PORTAL_PUBLIC_URL` | `https://emit-select.com` |
| `TURSO_DATABASE_URL` | The `libsql://` URL for the production database. |
| `TURSO_AUTH_TOKEN` | A full-access token for that database. |
| `BLOB_READ_WRITE_TOKEN` | Filled in when the Blob store is connected. |
| `DEMO_SEED` | `false` |
| `NEXT_PUBLIC_DEMO_HINT` | `false` |
| `SELECT_ADMIN_EMAILS` | `mgray@goselect.com,dmartin@goselect.com` |
| `EMIT_EMAIL_DOMAINS` | `emit.com,emittechnologies.com` |
| `GOOGLE_CLIENT_ID` | Select Workspace OAuth client id. |
| `GOOGLE_CLIENT_SECRET` | That client's secret. |
| `GOOGLE_HOSTED_DOMAIN` | `goselect.com` |

Leave these blank unless you are turning that feature on:

| Variable | When |
| --- | --- |
| `EMIT_ALLOWED_EMAILS` | An EMIT person whose email is not on `EMIT_EMAIL_DOMAINS`. |
| `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET` | Only if EMIT later wants Microsoft sign-in. Not required. |
| `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` | Optional assistant. Blank uses the built-in answers. |
| `CARRIER_PHOTO_INGEST_TOKEN` | Bearer token for the photo ingest API. Admins can upload without it. |
| `SAM_API_BASE_URL`, `SAM_API_TOKEN`, `SAM_CUSTOMER_ID` | Leave blank. SAM is not connected. |

Do not set `DEMO_USER_PASSWORD` in production. Do not set a Gmail client. Order mail has been removed.

`ALLOW_PASSWORD_LOGIN` is not a variable anymore. Email and password is how EMIT signs in.

## Go-live checklist

1. Create a Turso database for production (not the preview database) and copy its URL and token into the Production env.
2. Connect a Vercel Blob store to the project so `BLOB_READ_WRITE_TOKEN` is set for Production.
3. Set `AUTH_SECRET`, `DEMO_SEED=false`, and `NEXT_PUBLIC_DEMO_HINT=false`.
4. Set `PORTAL_PUBLIC_URL` to `https://emit-select.com`.
5. Set `EMIT_EMAIL_DOMAINS` to the real EMIT domains. Drop `emit.example`.
6. In Google Cloud, OAuth consent screen **Internal**, client type Web application.
   - Authorized redirect URI: `https://emit-select.com/api/auth/google/callback`
   - Authorized JavaScript origin: `https://emit-select.com`
   - Scopes: `openid`, `email`, `profile`
   - Put the client id and secret in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
7. Move the domain off the old Lovable app (steps below) and redeploy Production.
8. Sign in as `mgray@goselect.com` or `dmartin@goselect.com` with Google. That first sign-in creates the admin. There is no password for that account in production.
9. Open **Users**. Add each EMIT person (name and email). Set a temporary password or generate one, and send it to them yourself. The portal does not email it.
10. Ask one EMIT person to sign in and change the password under **Password**.
11. Submit a test order. Confirm the Select load column says Pending, then enter the real SAM number (for example `458934-1`) and confirm EMIT sees that number.
12. Add receiver companies under Settings only when a receiver should have a private link.

Microsoft sign-in can stay unconfigured. The login page hides that button until the Azure variables are set.

## Custom domain (emit-select.com)

The domain currently points at the old Lovable app. Vercel will serve this portal once DNS points at Vercel and the domain is attached to this project.

1. In the Vercel project, open **Settings → Domains** and add `emit-select.com`. Add `www.emit-select.com` only if you want it.
2. At the registrar that hosts DNS for emit-select.com, remove the records that send the name to Lovable (their A record, ALIAS, or CNAME).
3. Add the records Vercel shows on the domain page. For the apex name that is usually an **A** record:
   - Host: `@` (or the apex)
   - Value: `76.76.21.21`
   If the DNS host supports ALIAS or ANAME, `cname.vercel-dns.com` is the other form Vercel accepts. For `www`, add a **CNAME** to `cname.vercel-dns.com`.
4. Wait until Vercel marks the domain Valid. Vercel requests the certificate. Do not turn on a proxy that rewrites the host.
5. Redeploy Production after `PORTAL_PUBLIC_URL=https://emit-select.com` is set. Tracking links and receiver links use that origin. The Google callback uses it too, so it matches the redirect URI above.
6. Open `https://emit-select.com` and sign in with Google. A preview URL (`*.vercel.app`) is not the production site.

If `PORTAL_PUBLIC_URL` is blank, production links fall back to `VERCEL_PROJECT_PRODUCTION_URL` (the domain attached to Production) and auth callbacks use the host the browser actually called. Set `PORTAL_PUBLIC_URL` anyway so a preview deployment cannot mint a production link.

## Select load numbers

Submitting an order stores it with no load number. EMIT, the tracking page, and receiver links show Pending. A Select admin enters the number from SAM on the order. The shape is the SAM load number, loosely `458934-1` (digits, a dash, digits). A duplicate number is rejected. Clearing the field returns the order to Pending.

When a SAM API exists, call `syncSelectLoadNumberFromSam` in `lib/select-load.ts` with the TMS payload. That writes the same column with source `sam`. It does not invent a number when SAM has not assigned one, and it does not copy carrier cost.

## EMIT passwords

Select admins create users on **Users**. They can type a temporary password or generate one. The generated password is shown once. Deactivate stops sign-in immediately, including a cookie that was already issued. A user changes their own password on **Password**. Five failed attempts on one email, or thirty from one IP, lock that bucket for 15 minutes. Resetting the password clears the email lock.

There is no self-service signup and no password email. Azure is not involved.

## Carrier pay

Nothing in this go-live changes the carrier-pay rule. It is not a column, not a form field, and not in the assistant's context. Held rate confirmations stay on the admin review queue.

See [docs/REPORT.md](docs/REPORT.md) for the screening rules, receiver links, and the SAM client that is still not wired up.
