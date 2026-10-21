# EMIT portal

Production target is https://emit-select.com. EMIT signs in with email and password. Select admins sign in with Google. The portal does not send order email and does not invent a SAM load number. A Select admin enters that number after building the load in SAM. `DEMO_SEED=false` starts empty. The go-live checklist is in the README.

The notes below also describe the demo seed and the screening rules. Demo load numbers such as 900196-1 exist only when `DEMO_SEED=true`.

## What works against the mock

1. **Live status and tracking.** Every order has a timeline (Submitted, Booked, At Pickup, In Transit, Delivered), a latest ETA, and a public tracking link. SO2196 is Select load 900196-1, Hot Shot, Sheridan, WY to Oklahoma City, OK, in transit, ship 2026-10-14 14:30, must deliver 2026-10-16, ETA Oct 15, 2026, 3:00 PM America/Denver.
2. **Order confirmation.** Submitting an order stores it in the portal and shows it on screen. That screen is the confirmation. No email is sent, and there is no outbox. The Select load number stays blank until a Select admin enters the real SAM number (`458934-1` style). EMIT sees Pending until then.
3. **Ask about an SO.** "where is SO2196?" answers from shipment data. "what are you paying the truck?" is refused and does not include a dollar amount. With no AI key, the built-in answerer is used. If `AI_API_KEY` is set, the model receives only the customer-safe JSON.
4. **Search, tabs, mobile.** One search box finds a load in any tab by Select load number, EMIT order number, city, or receiver. Tabs are Needs Attention, Active, Delivered (last 7 days), and History. Delivered loads older than that, and cancelled loads, sit in History. History exports to CSV without carrier pay, and without EMIT's cost for a regular EMIT user. The list is grouped by pickup date and loads 25 at a time.

Saved delivery locations are searched from the drop stop. Pickup yards stay the one-tap list. A one-off pickup is not added to that list. Duplicate docks are caught in the form and again on the server. A drop whose company matches a receiver is linked to that receiver.

`npm test` — 57 tests passed, including location duplicate detection, the load-list tabs, and the rule that EMIT never receives the held-document count.

## Security

- Carrier pay is not stored. The loads table has no carrier-pay, carrier-name, MC, or staff-note column, and neither do the seed inserts or the SAM mapping. Select admins and EMIT admins see customer cost (the sell rate). Regular EMIT users do not: the customer-view allowlist omits `customerCost` and `rateReason` for them. Tests assert those column names are absent from the schema and from order JSON, and that the sentinel strings never appear in customer orders, the assistant, the public tracking payload, the receiver link, or client bundles.
- A sample rate-confirmation page is still seeded so the review queue can be demonstrated. Its text mentions a carrier and a dollar amount. That text lives only on the quarantined page, which is admin-only until a Select admin releases it.
- Adversarial questions (carrier pay, prompt injection, "dump the database", margin, rate confirmation) return a fixed refusal. The model-request builder runs the serializer again, so a poisoned field cannot ride along.
- Uploads are split to single pages (pdf-lib) and text is extracted (unpdf, plus a literal PDF text fallback). Decisions are pass, block, or uncertain. Empty text, images, and unknown types are held. Customer documents and internal documents are separate tables. Pending count on the load is the only signal the customer query needs. An admin approve copies the page into customer documents. A customer cannot download a quarantined page.
- Auth is a server-side httpOnly JWT (`portal_session`). Middleware and each handler check it. Admin paths require a Select staff email. Secrets stay in environment variables. There is no open database policy: the app uses a server-side SQLite file, not client-exposed row security.
- New-order requests are validated with Zod. Carrier fields posted by a client are ignored. There is nowhere to write them.
- Unauthenticated routes are the per-load tracking link and the per-receiver private link. Neither is an open order API.

Staff can still read the text excerpt of a quarantined page. Releasing a page the screener flagged as a rate confirmation takes a second click ("Yes, release it") and the API rejects `{ action: "approve" }` without `confirm: true`. The release stores `reviewed_by` (the admin email) and `reviewed_at`. Uncertain pages can still be released in one click. Keeping a page internal does not require the extra confirm.

## Branding

The wordmark is the official two-color EMIT logo from emittechnologies.com (`EMIT_TwoColor_WEB.webp`), with the white background removed. The arc is orange, about `#B75D27`. It is served from `public/brand/emit-logo.png`.

The attached portal screenshots were not on disk in this environment, so the chrome colors were matched by eye to the images in the request:

- Page `#1b1e24`, cards `#252a32`, header `#14171c`
- Status gold `#d4a017`, green `#3cba6c`, blue `#3d8bfd`, red `#e15b64`
- Focus and buttons `#e08a2f`, which is brighter than the logo orange so the focus ring stays visible on the dark background

What is not an exact match:

- The logo is the official mark made transparent, not a pixel crop of the Lovable header.
- Interactive orange is `#e08a2f`, not the logo's `#B75D27`.
- Dates use the browser's native date control, not the "October 14th, 2026" picker in the old dialog.
- The typeface is the system UI font.
- Stat cards show the 24 demo loads, not the 587 live loads.
- Ship-from names are `EMIT` plus a short location, so the yards are distinct. See the list below.

## Multi-stop loads

A load is an ordered list of pickups and drops, not only one origin and one destination. The form starts with one of each. Add pickup and Add drop append a stop. Up, Down, and the Drag handle reorder them, including after the load is saved. Remove deletes a stop. Save is blocked unless there is at least one pickup and one drop. If a drop is listed before every pickup, the form shows a warning and still saves, because that sequence is sometimes real.

The first pickup is the origin column and the last drop is the destination column, so the existing table, search, and tracking summary keep working. Intermediate cities are searchable. A receiver link includes a load when any drop matches that company, not only the last one. The demo load SO4555 has two pickups and one Enchanted Rock drop. Public tracking lists each stop as city and state only.

### How saved stop edits sync to SAM

They do not sync yet. The running app writes the ordered list to `stops_json` in the mock store. `lib/sam.ts` already has the contract for when credentials arrive:

- Create sends `toSamStops`: the full list with `sequence` 1..n, type Pickup or Delivery, and the address. The first pickup carries the ship date and time. The last drop carries the must-deliver date. No carrier fields are included.
- A later edit sends that same full list again via `SamTmsClient.replaceStops`, a PUT to `/v1/loads/{loadNumber}/stops`. SAM is expected to replace the load's stops in that order. The portal does not send a diff, so a removed stop disappears and a reordered stop keeps its new index.
- Reading a SAM order maps every stop back onto `stops`. The first pickup and the last delivery still fill origin and destination. Extra keys on a SAM stop, including a carrier rate, are dropped by the customer serializer.

Those HTTP paths are still a placeholder. Wiring `submitOrder` and `updateOrder` to call the client is the change to make when Mike's API contract is confirmed. Until then, a saved edit is only in the portal database (local SQLite, or Turso when `TURSO_DATABASE_URL` is set).

## Carrier photos

Each load has a photo gallery. Select admins and EMIT staff can view it while signed in. A receiver sees photos only through that company's private link. The public tracking link does not show photos. Photos are not customer documents: this path never accepts or displays a PDF or other document.

The demo seeds an orange dock photo on SO2196 (Select load 900196-1) and a Cypress arrival photo on SO4555. A second SO2196 image is stored with rate-confirmation text in the file. EMIT and receiver links do not see that image. An admin does, marked held.

### Ingest API

`POST /api/ingest/carrier-photos`

Auth, either one:

- `Authorization: Bearer <CARRIER_PHOTO_INGEST_TOKEN>` for the Gmail assistant. The token is at least 16 characters, compared in constant time, and stays in the server environment. This path is exempt from the session-cookie middleware so a token-only caller gets JSON instead of a login redirect. A wrong or missing token is 401.
- An admin session cookie, which is what the upload control on a load uses. EMIT and receiver sessions are 403.

JSON body:

```json
{
  "loadNumber": "900196-1",
  "source": "gmail:18f3c0ab12e",
  "receivedAt": "2026-10-14T16:10:00Z",
  "filename": "dock.png",
  "contentType": "image/png",
  "subject": "Driver at the Sheridan dock",
  "dataBase64": "<raw or data-URL base64>"
}
```

`loadNumber` is the SAM load number (`900196-1`), not the EMIT sales order. `source` is where the assistant found it (Gmail message id is a good value). `receivedAt` is the email's timestamp, ISO-8601 with a timezone. `subject` is optional and is screened with the filename and any text embedded in the file.

Multipart form fields are `file`, `loadNumber`, `source`, `receivedAt`, and optional `subject`. Same auth.

Responses:

- `201` the image was stored. `200` the same bytes were already on that load (`duplicate: true`); the first copy is kept.
- `404` no load with that number. `415` the bytes are a PDF, another document, or not jpg/png/heic/webp. Contents are sniffed; a PDF renamed `.jpg` is rejected.
- `visibleToCustomer: false` and `heldReason` mean the image was stored for Select only.

The same SHA-256 on one load is one row. A later retry does not create a second photo.

Filename, source, subject, and printable strings inside the file (PNG text, EXIF, and similar) go through the same rate-confirmation checks as documents. A hit is stored with `held = 1`. EMIT and receiver links get neither the row nor the bytes (404). Admins still see it in the gallery, labeled held. There is no release action on this path, so a rate-confirmation lookalike cannot be pushed to EMIT. The check does not OCR pixels. A photograph of a paper rate confirmation with no embedded text can still be shown; the assistant should pass the email subject so that signal is screened.

Gallery reads, all session-authenticated and scoped like the load:

- `GET /api/orders/{id}/photos` returns id, filename, type, source, subject, and received time. Held rows are included only for admins.
- `GET /api/carrier-photos/{id}` returns the image bytes. Held bytes are admin-only.

## Data layer and SAM

`lib/orders.ts` is the store the app uses today: list, get, submit, update, stats, all returning the customer-safe shape. Submit writes the order with a null Select load number. `lib/select-load.ts` is where an admin, or a future SAM sync, fills that number in. There is no email step and no Slack step.

`lib/sam.ts` is the drop-in HTTP client. `pickCustomerRate` reads `customerRate` or `customerCharges.lineHaul` / `customerCharges.customerTotal` and never falls back to `carrierCost`. `toSamCreatePayload` does not include carrier fields. The paths (`/v1/customers/{id}/orders`) are a placeholder. The client is unit-tested with a fixture that includes carrier cost 8765.43 and customer rate 1500. It is not called by the running routes. Wiring it is the change to make when Mike's credentials and the real paths arrive. Until then, orders "in SAM" means rows in the portal database.

Documents, users, and the review queue stay in that database even after orders move to SAM. Document and photo bytes are not in the database. They live in Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set, and in `data/blobs` (or memory, during tests) otherwise. The database stores a locator.

## Ship-from sites

| Name | Address |
| --- | --- |
| EMIT ALLEN | 2437 Allen Avenue, Sheridan, WY 82801 |
| EMIT NORTH | 2571 North Main Street, Sheridan, WY 82801 |
| EMIT PA | 102 Ford Cove Drive, Canonsburg, PA 15317 |
| VECTIS LOVELAND | 451 St Cloud Dr, Loveland, CO 80538 |

EMIT PA is the PEN site. The city is Canonsburg. VECTIS LOVELAND is not an EMIT yard; the name stays distinct so it is not read as one. Admins can still add, edit, and remove sites under Settings.

## Receivers

Receivers do not sign in. EMIT staff use a password. Settings → Receivers is empty until an admin adds a company. The demo seed adds one example, Enchanted Rock LLC, with contact `ops@enchantedrock.example`, so the link can be tried. Production with `DEMO_SEED` off starts with no receivers.

Each company has contact emails, a long random token, and a URL `{PORTAL_PUBLIC_URL}/r/{token}`. Admins can edit the company and emails, copy the link, regenerate it (the old URL stops working), disable it (same URL, 404 until enabled again), or remove the company. A disabled or unknown token returns the same "not valid" response.

The page lists only loads with a drop at that company (any drop, not only the last). It shows status, the stop sequence as company and city/state, ETA, a link to the portal status page, a Track button when Select has saved a SAM or MacroPoint share link, and photos. It does not show customer cost, carrier pay, comments, or documents, so a released rate confirmation never appears there. Held photos are omitted.

## Auth

EMIT uses email and password. Select admins use Google. Receivers do not sign in. Microsoft is optional code and is not required for go-live.

- **Password** is how EMIT staff sign in. A Select admin creates them under Users, sets or generates a temporary password, and can deactivate them. The person changes that password under Password. Five failures on one email, or thirty from one IP, lock sign-in for 15 minutes. A password change or an admin reset invalidates older cookies. There is no self-service signup and no password email.
- **Google** is for Select staff. The Workspace hosted domain is `goselect.com`. The only admins are `mgray@goselect.com` (Mike Gray) and `dmartin@goselect.com` (Drew Martin), from `SELECT_ADMIN_EMAILS`. Any other Google account is rejected. EMIT addresses are rejected and told to use email and password. There is no EMIT admin role. The first production sign-in has to be one of these Google accounts. That creates the admin who can then add EMIT users.
- **Microsoft (Entra ID)** can stay unset. If it is configured later, an EMIT domain (`EMIT_EMAIL_DOMAINS`) or an address in `EMIT_ALLOWED_EMAILS` can sign in as EMIT staff. A Select address is rejected and told to use Google. A deactivated user is rejected here too.

### What Mike needs to create

Google sign-in, in Select's Google Cloud project, OAuth consent screen set to **Internal** (goselect.com only). This client is only for staff login.

- OAuth client type: Web application.
- Authorized redirect URI: `https://emit-select.com/api/auth/google/callback`
- Authorized JavaScript origin: `https://emit-select.com`
- Scopes: `openid`, `email`, `profile`
- Client id and secret go in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. `GOOGLE_HOSTED_DOMAIN` stays `goselect.com`.

The portal also sends `hd=goselect.com` so the Google screen prefers the Select Workspace.

Microsoft is not part of go-live. If EMIT asks for it later: app registration, type Web, single tenant, redirect URI `{PORTAL_PUBLIC_URL}/api/auth/microsoft/callback`, scopes `openid`, `profile`, `email`, and the three `AZURE_AD_*` values. Leave them blank until then.

Order confirmation email has been removed. There is no Gmail client and no outbox.

## Hosting

Vercel, connected to this GitHub repo, is ready. Previews come from pull requests. Production follows `main`. `vercel.json` sets the Next.js framework, region `iad1`, and a 60 second function limit so the first preview request can finish the demo seed.

The database is Turso (hosted libSQL). The schema, `PRAGMA` checks, and `json_extract` / `json_each` queries stay SQLite, so the sentinel tests still run unchanged against local SQLite. Postgres would have been a second dialect and a local Postgres install. Turso is two environment variables and a database created in the browser.

Document and photo bytes go to Vercel Blob (private). The database stores a locator, not the file. With no Blob token, local dev writes `data/blobs`. Tests keep bytes in memory. With no Turso URL, local dev and tests use `node:sqlite` (`data/portal.db` or `:memory:`). On Vercel those two variables are required; the app throws if either is missing so a preview cannot silently write to an ephemeral disk.

`DEMO_SEED=true` on a Preview loads the fake shipments, the three demo logins, and the Enchanted Rock LLC receiver link the first time the database is empty. A second cold start that loses the race on the demo emails leaves the first seed in place. Production should set `DEMO_SEED=false`.

Click-by-click steps for Mike are in the README. Docker still runs the local-disk mode if Turso and Blob are unset:

```bash
docker build -t emit-portal .
docker run --rm -p 3000:3000 \
  -e AUTH_SECRET="<long random string, 16+ characters>" \
  -e PORTAL_PUBLIC_URL="https://<test-host>" \
  -e DEMO_SEED=true \
  -e DEMO_USER_PASSWORD="Emit-Demo-2026" \
  -v emit-portal-data:/app/data \
  emit-portal
```

Set `DEMO_SEED=false` before any real EMIT user can sign in. With that set, a new database has no users and no demo password. `AUTH_SECRET` shorter than 16 characters throws on startup in production. Leave `NEXT_PUBLIC_DEMO_HINT` unset or `false` in production. The demo password is not included in the page unless the server is actually seeding the demo. Set `PORTAL_PUBLIC_URL` to `https://emit-select.com` so tracking links, receiver links, and the Google callback use the custom domain. If it is blank in production, links use `VERCEL_PROJECT_PRODUCTION_URL` rather than the per-deployment `VERCEL_URL`.

There is no public test URL in this environment.

## Environment variables still needed

| Variable | Who provides it | Used for |
| --- | --- | --- |
| `AUTH_SECRET` | Select, generate a long random string | Session signing. Required in production. |
| `TURSO_DATABASE_URL` | Turso, the `libsql://` URL | Hosted database on Vercel. Leave unset locally. |
| `TURSO_AUTH_TOKEN` | Turso, full-access token | Auth for that database. Leave unset locally. |
| `BLOB_READ_WRITE_TOKEN` | Vercel, added when the Blob store is connected | Private document and photo bytes. Leave unset locally. |
| `PORTAL_PUBLIC_URL` | `https://emit-select.com` | Tracking links, receiver links, and the Google callback. |
| `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET` | Leave blank | Optional Microsoft sign-in. Not required. |
| `SELECT_ADMIN_EMAILS` | Defaults to `mgray@goselect.com,dmartin@goselect.com`. Change only if those addresses change. | |
| `EMIT_EMAIL_DOMAINS` or `EMIT_ALLOWED_EMAILS` | Mike | Which addresses a Select admin may create as EMIT password users. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Select Google Cloud, internal OAuth client | Select admin sign-in. |
| `GOOGLE_HOSTED_DOMAIN` | Default `goselect.com` | Workspace domain check. |
| `AI_API_KEY`, optional `AI_BASE_URL`, `AI_MODEL` | Select | OpenAI-compatible chat. Blank uses the built-in answerer. |
| `CARRIER_PHOTO_INGEST_TOKEN` | Select | Bearer token for the photo ingest API. At least 16 characters. |
| `SAM_API_BASE_URL`, `SAM_API_TOKEN`, `SAM_CUSTOMER_ID` | Mike, already requested | Live orders. Not connected until the HTTP contract is confirmed. |

`PORTAL_DB_PATH` defaults to `./data/portal.db` and is used only when `TURSO_DATABASE_URL` is unset. `PORTAL_BLOB_DIR` defaults to `./data/blobs` when Blob is unset.

## Assumptions

- The Cost field on a load is EMIT's rate with Select. Select admins and EMIT admins see it. Regular EMIT users do not, and neither do receiver links. Carrier pay is not a field anywhere in the portal.
- "This week" is Monday through Sunday in America/Denver.
- Ship and appointment times are Denver wall-clock times.
- Google Maps is a search link. There is no Maps API key.
- Uploads are not virus-scanned. Max 8 MB and 25 pages.
- A page the screener cannot read is held, including photos and Word files.
- Cancelled loads stay on the dashboard and can be filtered.
- A receiver link matches the company string on a drop, case-insensitive. The admin types that name. The demo company is Enchanted Rock LLC.
- The public tracking link is still a per-load capability URL. It does not list other loads.
- Demo tracking tokens are `sha256("emit-demo:" + loadNumber)` and are predictable. New orders use 24 random bytes. Receiver tokens are 32 random bytes.
- Demo load numbers 900181–900204 are fake and exist only when `DEMO_SEED=true`. New orders leave the Select load number empty. The rate-confirmation sample page is a screening fixture, not stored carrier pay.
- The 587 migrated loads do not need historical document screening.
- Saved stop edits will sync to SAM as a full replacement of that load's stops (`PUT /v1/loads/{loadNumber}/stops`) once the API exists. That call is not wired in yet.
- The SAM HTTP paths are a guess and must be replaced with the real contract. Customer responses would still pass through the same serializer.

## Open questions

Answered and in this build: a Select admin may release a flagged rate confirmation after an explicit confirm, and the portal logs who and when. EMIT admins see customer cost. Regular EMIT users do not. Carrier pay is not stored and is hidden from EMIT admins too. The portal is the confirmation. No order email is sent. EMIT signs in with a password a Select admin sets. Select admins sign in with Google and can mark an EMIT user as an EMIT admin. Microsoft is optional. Receiver companies and contact emails are edited in admin. Receivers use a private link and do not sign in. A Select admin can paste a public tracking link on each load. The public site is emit-select.com. Vercel hosting uses Turso for the database and Vercel Blob for document and photo bytes. Local dev still uses SQLite and files.

Still open:

1. SAM base URL, auth scheme, EMIT's customer id, and the real endpoints. Until those exist, a Select admin types the load number and the public tracking link. `syncSelectLoadNumberFromSam` and `syncTrackingLinkFromSam` are the functions to call once a payload is available.
2. Which model should answer questions once `AI_API_KEY` exists?
3. DNS for emit-select.com has to move off the old Lovable records onto the Vercel records in the README.
