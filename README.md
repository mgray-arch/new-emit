# EMIT Load Order Portal

Customer portal for EMIT Technologies, a shipper of Select Transport Partners. It replaces the old Lovable app. Put it on a new domain. Do not reuse the old site's hostname unless that is the name you want.

EMIT admins and regular EMIT users sign in with email and password. Select staff sign in with Google. Select adds each EMIT email on Users, marks them as an EMIT admin or a regular user, and gives them one permission: view only, add loads, see pricing, or full access. See pricing and full access show the price EMIT pays Select. They never show carrier pay. Carrier pay stays hidden from every EMIT user, in every role and permission, including when Select is viewing as that person. The portal is the order confirmation: it does not send email. There is no SAM API. Select can send a load to the Load Builder bot, or type the SAM load number. Until a number is stored, EMIT sees **Pending**. The portal does not invent a load number.

The public hostname is not hardcoded. Set `PORTAL_PUBLIC_URL` to the domain this portal should use. `emit-select.com` in this file is only an example of a previous plan. Google's redirect URI has to match whatever domain you attach. `goselect.com` is Select's Google Workspace, not the portal's address.

Orders, users, and the document review queue live in Turso. Document and photo bytes live in Vercel Blob. Locally, with those unset, the app uses a SQLite file and `data/blobs`.

## What EMIT can do

- Broker dashboard with status counts, ship-date range, search, and pagination. A load can have any number of pickups and drops.
- Submit a load. The order appears in the portal immediately. That screen is the confirmation. No email is sent.
- See the Select load number once a Select admin has entered it. Before that, the column says Pending.
- Open a Track button when a Select admin has pasted the SAM or MacroPoint share link.
- Status timeline, latest ETA, and the portal's own status page.
- Carrier photo gallery. Rate-confirmation images stay with Select admins.
- Ask about an SO. Answers come from the customer-safe shipment view. View only and add loads do not get pricing in that answer. See pricing and full access do. The answer never includes carrier pay.

Select staff also get the document review queue, ship-from sites, receiver companies, the EMIT user list, and **Build load in SAM**. On Users they choose EMIT admin or regular user, plus view only, add loads, see pricing, or full access. EMIT cannot open that page. A **View as** switch lets Select look at the portal as an EMIT admin or a regular EMIT user, at any of those permissions. The preview is read-only.

## Security boundary

Customer responses are an allowlist. Carrier pay is not stored. The serializer drops a carrier-pay field if one is posted, and the assistant reads that same view. Questions about carrier pay, margins, or rate confirmations are refused before any shipment data is attached. View only and add loads also have `customerCost` and `rateReason` removed from that allowlist, including list, detail, and assistant responses. See pricing and full access receive EMIT's cost, and so does Select. Those responses still have no carrier pay. View only, add loads, and see pricing cannot change a stored cost by saving a load (see pricing cannot save a load at all). A Select view-as preview uses the same allowlist as the permission being previewed, and it cannot write. The SAM build status and SAM link are Select-only and are omitted from every EMIT response and from view-as.

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
| EMIT regular, add loads | m.gray@emit.example | Emit-Demo-2026 | Email and password |
| EMIT regular, view only | viewer@emit.example | Emit-Demo-2026 | Email and password |
| EMIT regular, see pricing | pricing@emit.example | Emit-Demo-2026 | Email and password |
| EMIT admin, full access | lead@emit.example | Emit-Demo-2026 | Email and password |
| Select | mgray@goselect.com | Emit-Demo-2026 | Google |
| Select | dmartin@goselect.com | Emit-Demo-2026 | Google |

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
| `PORTAL_PUBLIC_URL` | The portal's public origin, with no trailing slash. Example: `https://portal.example.com`. This is the only hostname the app uses for links and the Google callback. |
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

## Preview environment variables

Vercel Preview builds with `NODE_ENV=production`. An unset `DEMO_SEED` does **not** create `m.gray@emit.example`. Variables checked only for Production are invisible to the preview, so email sign-in fails and the page cannot open a database. Google stays off until `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` exist. That part is expected.

Sign-in does not use Blob. A missing `BLOB_READ_WRITE_TOKEN` only blocks file uploads, and the upload error names that variable.

Use a **second Turso database** for Preview. If Preview points at the production database and `DEMO_SEED=true`, a preview deploy writes the demo company into production when that database has no users yet.

1. Open the Vercel project [new-emit](https://vercel.com/mgray-arch/new-emit) → **Settings** → **Environment Variables**.
2. Add each row below with **Preview** checked. Leave **Production** alone. If a name already exists for Production only, add a separate Preview value. Do not flip the Production `DEMO_SEED=false` onto Preview.
3. `AUTH_SECRET` — any new random string, at least 16 characters. Preview can use its own.
4. In the Turso dashboard, create a database named `emit-preview`. Copy its `libsql://` URL and a full-access token.
5. `TURSO_DATABASE_URL` — that preview URL. Not the production URL.
6. `TURSO_AUTH_TOKEN` — the token for that same preview database.
7. `DEMO_SEED` — `true` for Preview. Production stays `false`.
8. `NEXT_PUBLIC_DEMO_HINT` — `true` for Preview, so the sign-in page shows the test password. Production stays `false`.
9. Leave `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` empty until the Workspace OAuth client exists. The Google button stays hidden, with a note to use email and password.
10. Leave `PORTAL_PUBLIC_URL` unset on Preview so links use the preview host. Production is the new hostname.
11. `BLOB_READ_WRITE_TOKEN` — optional for clicking around. Add a Preview token only when you want uploads to work. Connect the Blob store to Preview, or paste a token and check Preview.
12. **Deployments** → the latest Preview deployment → **Redeploy**. Environment changes do not apply to a deployment that is already built.
13. Open the preview URL. Sign in as `m.gray@emit.example` / `Emit-Demo-2026`.

A new preview updates the preview database when its server starts. Accounts and loads stay. Refresh the Loads page after the deployment is Ready. Signing out is not required.

If a name is still missing, the sign-in page lists it. Redeploy after you save the variable.

No new environment variables were added for the SAM button, view-as, or EMIT permissions. The SAM button uses the three variables already in the table below.

Leave these blank unless you are turning that feature on:

| Variable | When |
| --- | --- |
| `EMIT_ALLOWED_EMAILS` | An EMIT person whose email is not on `EMIT_EMAIL_DOMAINS`. |
| `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET` | Only if EMIT later wants Microsoft sign-in. Not required. |
| `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` | Optional assistant. Blank uses the built-in answers. |
| `CARRIER_PHOTO_INGEST_TOKEN` | Bearer token for the photo ingest API. Admins can upload without it. |
| `BOT_UPLOAD_KEY` | Bearer token for the email bot. At least 16 characters. Same key for `POST /api/integrations/documents` and `POST /api/integrations/tracking-link`. |
| `LOAD_BUILDER_WEBHOOK_URL` | Where **Build load in SAM** posts the load. `http` or `https`. Unset: the button returns an error and the load is not marked building. |
| `LOAD_BUILDER_SECRET` | Shared bearer secret, at least 16 characters. Sent to the webhook and required on the callback. |
| `SAM_LOAD_URL_TEMPLATE` | Link for a stored SAM number. Must contain `{loadNumber}`. Example: `https://sam.example.com/loads/{loadNumber}`. Unset: the number shows and is not a link. |
| `SAM_API_BASE_URL`, `SAM_API_TOKEN`, `SAM_CUSTOMER_ID` | Leave blank. The portal does not call the SAM API. |
| `SLACK_NEW_LOADS_WEBHOOK_URL` | Slack incoming webhook for a new-load note. Unset: no Slack message is sent. The note does not include carrier pay. |
| `SLACK_USER_ID_DREW`, `SLACK_USER_ID_AINSLEY` | Optional Slack member ids so the owner line @mentions that person. Unset: the note uses the names Drew and Ainsley. |

Do not set `DEMO_USER_PASSWORD` in production. Do not set a Gmail client. Order mail has been removed.

`ALLOW_PASSWORD_LOGIN` is not a variable anymore. Email and password is how EMIT signs in.

## Go-live checklist

1. Create a Turso database for production (not the preview database) and copy its URL and token into the Production env.
2. Connect a Vercel Blob store to the project so `BLOB_READ_WRITE_TOKEN` is set for Production.
3. Set `AUTH_SECRET`, `DEMO_SEED=false`, and `NEXT_PUBLIC_DEMO_HINT=false`.
4. Set `PORTAL_PUBLIC_URL` to `https://` plus the new hostname, with no trailing slash.
5. Set `EMIT_EMAIL_DOMAINS` to the real EMIT domains. Drop `emit.example`.
6. In Google Cloud, OAuth consent screen **Internal**, client type Web application.
   - Authorized redirect URI: `{PORTAL_PUBLIC_URL}/api/auth/google/callback`
   - Authorized JavaScript origin: the same origin, with no path
   - Scopes: `openid`, `email`, `profile`
   - Put the client id and secret in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
7. Attach the new domain (steps below) and redeploy Production. Leave the old Lovable hostname where it is.
8. Sign in as `mgray@goselect.com` or `dmartin@goselect.com` with Google. That first sign-in creates the admin. There is no password for that account in production.
9. Open **Users**. Add each EMIT person (name and email). Set a temporary password or generate one, and send it to them yourself. The portal does not email it. Choose **EMIT admin** or **Regular EMIT user**, and one permission: **View only**, **Add loads**, **See pricing**, or **Full access**. See pricing and full access are the only EMIT permissions that see what Select charges EMIT. An email that is not on this list cannot sign in.
10. Ask one EMIT person to sign in and change the password under **Password**.
11. Submit a test order. Confirm the Select load says Pending. Use **Build load in SAM** once the webhook is set, or enter the real SAM number (for example `458934-1`) and the public tracking link. Confirm EMIT sees that number and a Track button. Sign in as add loads and confirm the cost is gone. Sign in as full access and confirm the cost is there. Use **View as** and confirm the same split without signing out.
12. Add receiver companies under Settings only when a receiver should have a private link.

Microsoft sign-in can stay unconfigured. The login page hides that button until the Azure variables are set.

## Custom domain

Use a new domain for this portal. Do not point the old Lovable site's name at this app unless that name is the one you actually want. Nothing in the running code hardcodes `emit-select.com`. Links and the Google callback come from `PORTAL_PUBLIC_URL`. If that is blank in production, links fall back to `VERCEL_PROJECT_PRODUCTION_URL` (the domain attached to the Vercel project). Auth callbacks use the host the browser called when `PORTAL_PUBLIC_URL` is blank. Set `PORTAL_PUBLIC_URL` anyway so a preview deployment cannot mint a production link.

These are the only domain-shaped settings:

| What | Tied to |
| --- | --- |
| Portal links, tracking links, receiver links, Google callback | `PORTAL_PUBLIC_URL` |
| Select Google sign-in | `GOOGLE_HOSTED_DOMAIN` (default `goselect.com`) and the redirect URI you register, which must be `{PORTAL_PUBLIC_URL}/api/auth/google/callback` |
| Who may be added as EMIT | `EMIT_EMAIL_DOMAINS` and `EMIT_ALLOWED_EMAILS` |
| SAM load link | `SAM_LOAD_URL_TEMPLATE` |

1. In the Vercel project, open **Settings → Domains** and add the new hostname. Add `www` only if you want it.
2. At the registrar for that new name, add the records Vercel shows. For an apex name that is usually an **A** record:
   - Host: `@` (or the apex)
   - Value: `76.76.21.21`
   If the DNS host supports ALIAS or ANAME, `cname.vercel-dns.com` is the other form Vercel accepts. For `www`, add a **CNAME** to `cname.vercel-dns.com`.
3. Wait until Vercel marks the domain Valid. Vercel requests the certificate. Do not turn on a proxy that rewrites the host.
4. Set `PORTAL_PUBLIC_URL` to `https://` plus that hostname, with no trailing slash. In Google Cloud, set the authorized redirect URI to `https://<that-host>/api/auth/google/callback` and the JavaScript origin to `https://<that-host>`.
5. Redeploy Production. Open the new hostname and sign in with Google. A preview URL (`*.vercel.app`) is not the production site.

## Select load numbers

Submitting an order stores it with no load number. EMIT, the tracking page, and receiver links show Pending. A Select admin enters the number from SAM on the order. The shape is the SAM load number, loosely `458934-1` (digits, a dash, digits). A duplicate number is rejected. Clearing the field returns the order to Pending.

When a SAM API exists, call `syncSelectLoadNumberFromSam` in `lib/select-load.ts` with the TMS payload. That writes the same column with source `sam`. It does not invent a number when SAM has not assigned one, and it does not copy carrier cost. Call `syncTrackingLinkFromSam` in the same file with that payload to store `tracking.shareUrl` as the Track link. It does not clear a link when SAM has not published one.

## EMIT passwords

Select admins create users on **Users**. They can type a temporary password or generate one. The generated password is shown once. Deactivate stops sign-in immediately, including a cookie that was already issued. A user changes their own password on **Password**. Five failed attempts on one email, or thirty from one IP, lock that bucket for 15 minutes. Resetting the password clears the email lock.

There is no self-service signup and no password email. Azure is not involved.

## EMIT permissions and pricing

Select staff (`admin`) sign in with Google and can open Review, Users, and Settings. Every Select account can build a load in SAM and can use **View as**. EMIT people are added only on the Select Users page. Each person has an access and a permission:

| Access | What it changes |
| --- | --- |
| EMIT admin | Stored as `emit_admin`. Can manage saved delivery locations unless the permission is view only. |
| Regular EMIT user | Stored as `customer`. Cannot manage locations. |

| Permission | EMIT's price | Add loads |
| --- | --- | --- |
| View only | Hidden | No |
| Add loads | Hidden | Yes |
| See pricing | EMIT's cost only | No |
| Full access | EMIT's cost only | Yes |

See pricing means the customer price EMIT pays. It is not carrier pay. Carrier pay is hidden from every access and every permission, including full access and including Select while viewing as EMIT. An email that is not on the list cannot sign in, including through Microsoft.

EMIT's cost and the rate reason are included only for Select, see pricing, and full access. The other permissions do not receive those fields from the list, the load detail, a document upload, or the assistant, and a save from those users leaves the stored cost alone.

Pages held for Select review are hidden from every EMIT user, including full access, and from Select while **View as** is on. The list and the load page do not include the review count, and an upload just says it was uploaded.

**View as** is a cookie on top of a Select session. It does not change the Select account. Select picks EMIT admin or regular user, and a permission. The server applies that combination, so a see-pricing preview receives EMIT's cost and a view-only preview does not. The preview is read-only: creating a load, editing, uploading, changing a password, and editing locations are rejected. EMIT cannot set that cookie. Leaving the preview, or signing out, clears it. Admin pages are closed during the preview. The switch is not rendered for an EMIT session.

## Locations

Delivery stops search a saved list of drops. One field matches company, city, or street, with the most-used docks first. Picking a result fills the stop. Add new location opens the address on that same stop, and saving the load adds it to the list.

A likely duplicate (same dock with different capitalization, St/Street, a suite line, or a ZIP+4, or a close company name) asks you to use the existing location or save it as new. The server applies the same check. An exact address is reused instead of creating a second row.

Pickup stops keep the EMIT yards as large one-tap choices. Other pickup location is for that load only. It is not added to the yard list. Select edits the yards on Settings. An EMIT admin who is not view only can list, edit, merge, and deactivate drops on Locations. A regular EMIT user cannot. They see the yards but cannot change them.

A drop is linked to a receiver when the company name matches, so the receiver page still finds the load.

## Load lists

Select staff see four lists: **Needs Attention** (no Select load number, files in review, an in-transit load with no tracking link, or a past-due delivery), **Active**, **Delivered** for the last 7 days, and **History**. EMIT admins, regular EMIT users, and Select **View as** do not get that list, its count, or the Needs Attention badge. Those loads stay on Active or Delivered, so nothing is hidden from them. A delivered load moves to History on its own after those 7 days. Cancelled loads are in History too.

Each load is a card: the lane in bold, pickup and delivery dates, a colored status, and Track when there is a link. **Entered by** is on the card and the load page for Select and every EMIT user: the name and email, the email alone when the name is missing, or Unknown on older loads. That line is only the person. It is not carrier pay, and view only or add loads still do not see EMIT's cost. Long notes stay on two lines until you expand them. Open a card for the four-step timeline (Ordered, Booked, Picked up, Delivered) and the stops, documents, tracking, and notes. A PDF opens with **View PDF**, and a PNG or JPEG opens with **View**, both in a new tab. **Download** saves the file. Anything else only downloads. Light mode is in the header. EMIT users see a short tip the first time.

One search box looks through every list for a Select load number, an EMIT order number, a city, or a receiver. Date range, pickup site, receiver, and status narrow whichever list you are in. Loads are grouped by pickup date. The page loads 25 at a time.

History can be exported as CSV. The file never includes carrier pay. View only and add loads do not get EMIT's cost or the rate reason in that file. Select, see pricing, and full access do. A Select preview uses the same rule.

## Tracking links

Each load has a tracking link, separate from the portal status page. A Select admin pastes the public SAM or MacroPoint URL on the load. EMIT users and receivers get a Track button when it is set. The link has to be http or https. Clearing the field removes the button.

The email bot can set the same link. See the bot section below. An empty bot value does not clear a link.

## Bot document upload and tracking links

One key covers both. There is no second secret.

Send `Authorization: Bearer <BOT_UPLOAD_KEY>`. The key is at least 16 characters and compared in constant time. A missing, short, or wrong key is 401. A session cookie is not accepted. Both paths skip the session-cookie check so the bot does not sign in. They share a limit of 60 requests a minute per IP.

Name the load with `loadNumber` (a Select load number such as `458934-1`; `load_number` is accepted too), `salesOrderNumber` (`sales_order_number` too), or both. Both have to be the same load. No match is 404. More than one match, or a pair that points at different loads, is 409 and does not guess.

`POST /api/integrations/documents` uploads a file. The body is multipart: `file`, the load fields above, and optional `doc_type` (`bol`, `pod`, or `photo`). Omitted `doc_type` means `bol`. The file has to be a PDF, PNG, or JPEG, 8 MB or smaller. Anything else is 415. It is screened with the same page rules as an upload from the portal. A rate confirmation or a page with no readable text stays in Select review, so EMIT does not see it. The uploader is stored as Select bot. A BOL is filed as a BOL. The same file bytes on the same load are stored once; a retry returns the first result. This path cannot list, read, or delete documents.

`POST /api/integrations/tracking-link` sets the public share link. The body is JSON:

```json
{ "loadNumber": "458934-1", "trackingLink": "https://macropoint.example/share/abc" }
```

`salesOrderNumber` can stand in for the load number, or be sent with it. `tracking_link` is accepted too. The URL has to be http or https. A blank value, or `javascript:`, is 400 and leaves the current link in place. Sending the same URL again is 200 with `duplicate: true` and does not write a second row. A new URL is 201 and the source is `bot-email`. The response is the order id, sales order number, load number, link, and duplicate flag. It does not include cost or carrier pay.

## Build load in SAM

Select sees **Build load in SAM** on a load that has no SAM number yet, on the list and on the load page. The click calls the portal, and the portal posts the load to `LOAD_BUILDER_WEBHOOK_URL` with `Authorization: Bearer <LOAD_BUILDER_SECRET>`. The body is an allowlist: ids, stops, truck, dates, comments, and EMIT's cost. It does not include carrier pay.

The control shows four states: **Not built**, **Building**, **Built**, and **Failed**. While it is building, the button says **Building in SAM…** and checks the load until the bot calls back. A bot error is **Failed**, and the button says **Try build again**. A second click inside two minutes is rejected so the bot is not asked twice. After that, Select can try again.

The bot posts the SAM number to `POST /api/integrations/sam-load` with the same bearer secret. The body is JSON: `loadNumber` (such as `458934-1`) and either `orderId` or `salesOrderNumber`. The same number again is a no-op. A different number on a load that already has one is 409. A missing or wrong secret is 401. The path is limited to 60 requests a minute per IP. The response is `{ orderId, salesOrderNumber, loadNumber }` only.

Once the number is stored, the state is **Built**. The button becomes **SAM 458934-1** and links to `SAM_LOAD_URL_TEMPLATE` with `{loadNumber}` filled in. Without that template the number still shows, and it is not a link. EMIT never sees the build button, the build status, or carrier pay. View-as does not either.

## Carrier pay

Carrier pay is not a column, not a form field, and not in the assistant's context. Held rate confirmations stay on the admin review queue. That rule applies to full access and see pricing as well as view only and add loads, to EMIT admins and regular users, and to Select while viewing as any of those.

See [docs/REPORT.md](docs/REPORT.md) for the screening rules, receiver links, and the SAM client that is still not wired up.
