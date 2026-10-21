# EMIT Load Order Portal

Customer portal for EMIT Technologies, a shipper of Select Transport Partners. It replaces the old Lovable app on **emit-select.com**.

EMIT staff sign in with email and password. Select admins sign in with Google. A Select admin can mark an EMIT user as an EMIT admin. EMIT admins see EMIT's own cost. Regular EMIT users do not see pricing anywhere. Carrier pay stays hidden from every EMIT user, including EMIT admins. The portal is the order confirmation: it does not send email. There is no SAM API yet, so a Select admin types the real SAM load number and the public tracking link onto an order after building it in SAM. Until that number is entered, EMIT sees **Pending**. The portal does not invent a load number.

Orders, users, and the document review queue live in Turso. Document and photo bytes live in Vercel Blob. Locally, with those unset, the app uses a SQLite file and `data/blobs`.

## What EMIT can do

- Broker dashboard with status counts, ship-date range, search, and pagination. A load can have any number of pickups and drops.
- Submit a load. The order appears in the portal immediately. That screen is the confirmation. No email is sent.
- See the Select load number once a Select admin has entered it. Before that, the column says Pending.
- Open a Track button when a Select admin has pasted the SAM or MacroPoint share link.
- Status timeline, latest ETA, and the portal's own status page.
- Carrier photo gallery. Rate-confirmation images stay with Select admins.
- Ask about an SO. Answers come from the customer-safe shipment view. Regular EMIT users do not get pricing in that answer. EMIT admins do.

Select admins also get the document review queue, ship-from sites, receiver companies, and the EMIT user list. On Users, they choose who is an EMIT admin.

## Security boundary

Customer responses are an allowlist. Carrier pay is not stored. The serializer drops a carrier-pay field if one is posted, and the assistant reads that same view. Questions about carrier pay, margins, or rate confirmations are refused before any shipment data is attached. Regular EMIT users also have `customerCost` and `rateReason` removed from that allowlist, including list, detail, and assistant responses. EMIT admins and Select admins still receive EMIT's cost. A regular user cannot clear or set that cost by saving a load.

Every upload is split into pages and screened. A rate confirmation, or a page the screener cannot read, stays in an internal store. Releasing a flagged rate confirmation requires an explicit confirm and records the admin email and time.

Unauthenticated routes are the portal status page (`/track/[token]`) and a receiver's private link (`/r/[token]`). The status page returns cities, status, timeline, and ETA. It does not return cost, comments, documents, street address, or carrier data. Receiver links do not show customer cost or documents. When a tracking link is set, both show a Track button to the public SAM or MacroPoint page.

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
| `BOT_UPLOAD_KEY` | Bearer token for the SAM bot document upload. At least 16 characters. The bot can only upload. |
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
9. Open **Users**. Add each EMIT person (name and email). Set a temporary password or generate one, and send it to them yourself. The portal does not email it. Check **EMIT admin** only for the people who should see EMIT's cost.
10. Ask one EMIT person to sign in and change the password under **Password**.
11. Submit a test order. Confirm the Select load column says Pending, then enter the real SAM number (for example `458934-1`) and the public tracking link. Confirm EMIT sees that number and a Track button. Sign in as a regular EMIT user and confirm the cost is gone. Sign in as an EMIT admin and confirm the cost is there.
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

When a SAM API exists, call `syncSelectLoadNumberFromSam` in `lib/select-load.ts` with the TMS payload. That writes the same column with source `sam`. It does not invent a number when SAM has not assigned one, and it does not copy carrier cost. Call `syncTrackingLinkFromSam` in the same file with that payload to store `tracking.shareUrl` as the Track link. It does not clear a link when SAM has not published one.

## EMIT passwords

Select admins create users on **Users**. They can type a temporary password or generate one. The generated password is shown once. Deactivate stops sign-in immediately, including a cookie that was already issued. A user changes their own password on **Password**. Five failed attempts on one email, or thirty from one IP, lock that bucket for 15 minutes. Resetting the password clears the email lock.

There is no self-service signup and no password email. Azure is not involved.

## EMIT admins and pricing

There are three roles. **Select admin** (`admin`) signs in with Google and can open Review, Users, and Settings. **EMIT admin** (`emit_admin`) is an EMIT password user a Select admin marks on Users. **EMIT staff** (`customer`) is everyone else at EMIT.

EMIT's cost and the rate reason are included only for Select admins and EMIT admins. A regular EMIT user does not receive those fields from the list, the load detail, a document upload, or the assistant, and a save from that user leaves the stored cost alone. Carrier pay is hidden from EMIT admins too.

Pages held for Select review are hidden from every EMIT user, including EMIT admins. The list and the load page do not include the review count, and an upload just says it was uploaded.

## Locations

Delivery stops search a saved list of drops. One field matches company, city, or street, with the most-used docks first. Picking a result fills the stop. Add new location opens the address on that same stop, and saving the load adds it to the list.

A likely duplicate (same dock with different capitalization, St/Street, a suite line, or a ZIP+4, or a close company name) asks you to use the existing location or save it as new. The server applies the same check. An exact address is reused instead of creating a second row.

Pickup stops keep the EMIT yards as large one-tap choices. Other pickup location is for that load only. It is not added to the yard list. Select admins edit the yards on Settings. EMIT admins can list, edit, merge, and deactivate drops on Locations, and they see the yards but cannot change them.

A drop is linked to a receiver when the company name matches, so the receiver page still finds the load.

## Load lists

The dashboard is four lists: **Needs Attention** (no Select load number, files in review, an in-transit load with no tracking link, or a past-due delivery), **Active**, **Delivered** for the last 7 days, and **History**. A delivered load moves to History on its own after those 7 days. Cancelled loads are in History too.

Each load is a card: the lane in bold, pickup and delivery dates, a colored status, and Track when there is a link. Long notes stay on two lines until you expand them. Open a card for the four-step timeline (Ordered, Booked, Picked up, Delivered) and the stops, documents, tracking, and notes. Light mode is in the header. EMIT users see a short tip the first time.

One search box looks through every list for a Select load number, an EMIT order number, a city, or a receiver. Date range, pickup site, receiver, and status narrow whichever list you are in. Loads are grouped by pickup date. The page loads 25 at a time.

History can be exported as CSV. The file never includes carrier pay. A regular EMIT user does not get EMIT's cost or the rate reason in that file. Select admins and EMIT admins do.

## Tracking links

Each load has a tracking link, separate from the portal status page. A Select admin pastes the public SAM or MacroPoint URL on the load. EMIT users and receivers get a Track button when it is set. The link has to be http or https. Clearing the field removes the button.

## Bot document upload

Mike's bot posts a BOL from SAM email to `POST /api/integrations/documents`.

Send `Authorization: Bearer <BOT_UPLOAD_KEY>`. The key is at least 16 characters and compared in constant time. A missing or wrong key is 401. A session cookie is not accepted. The path skips the session-cookie check so the bot does not sign in, and it is limited to 60 requests a minute per IP.

The body is multipart: `file`, `loadNumber` (a Select load number such as `458934-1`; `load_number` is accepted too), and optional `doc_type` (`bol`, `pod`, or `photo`). Omitted `doc_type` means `bol`.

The file is screened with the same page rules as an upload from the portal. A rate confirmation or a page with no readable text stays in Select review. The uploader is stored as Select bot. The same file bytes on the same load are stored once; a retry returns the first result. This path cannot list, read, or delete documents.

An unknown load number is 404. A number that matches more than one load is rejected instead of guessing.

## Carrier pay

Carrier pay is not a column, not a form field, and not in the assistant's context. Held rate confirmations stay on the admin review queue. That rule applies to EMIT admins as well as regular EMIT users.

See [docs/REPORT.md](docs/REPORT.md) for the screening rules, receiver links, and the SAM client that is still not wired up.
