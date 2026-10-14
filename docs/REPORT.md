# EMIT portal — first version

Test portal for EMIT Technologies. It runs against a seeded mock of Select's SAM TMS. No public test URL was created in this environment. Deploy steps are below.

## What works against the mock

1. **Live status and tracking.** Every order has a timeline (Submitted, Booked, At Pickup, In Transit, Delivered), a latest ETA, and a public tracking link. SO2196 is Select load 900196-1, Hot Shot, Sheridan, WY to Oklahoma City, OK, in transit, ship 2026-10-14 14:30, must deliver 2026-10-16, ETA Oct 15, 2026, 3:00 PM America/Denver.
2. **Order confirmation.** Submitting an order returns Select's load number paired with EMIT's SO. The confirmation is stored in the outbox. The submit response includes the email body on screen because SMTP is not configured here. The message is also sent when `SMTP_HOST` and `SMTP_FROM` are set.
3. **Ask about an SO.** "where is SO2196?" answers from shipment data. "what are you paying the truck?" is refused and does not include a dollar amount. With no AI key, the built-in answerer is used. If `AI_API_KEY` is set, the model receives only the customer-safe JSON.
4. **Search, pagination, mobile.** Search matches SO or city. Page size is 8. Upcoming ship dates are listed first. Below 980px the table becomes stacked cards.

`npm test` — 27 tests passed (18 security, 4 stops, 3 access, 2 boundary).

## Security

- The customer order type has no carrier-pay fields. Customer SQL lists columns explicitly and omits `carrier_pay_cents`, `carrier_name`, `carrier_mc`, and `staff_notes`. The serializer drops unknown keys and redacts carrier-pay sentences in comments.
- Seed data plants carrier pay of $8,765.43, carrier BLACKHAWK HAULING LLC, MC 998877, and a staff note beginning `INTERNAL-ONLY-SENTINEL` on every load. Tests assert those strings never appear in customer orders, the assistant, the public tracking payload, or client bundles.
- Adversarial questions (carrier pay, prompt injection, "dump the database", margin, rate confirmation) return a fixed refusal. The model-request builder runs the serializer again, so a poisoned field cannot ride along.
- Uploads are split to single pages (pdf-lib) and text is extracted (unpdf, plus a literal PDF text fallback). Decisions are pass, block, or uncertain. Empty text, images, and unknown types are held. Customer documents and internal documents are separate tables. Pending count on the load is the only signal the customer query needs. An admin approve copies the page into customer documents. A customer cannot download a quarantined page.
- Auth is a server-side httpOnly JWT (`portal_session`). Middleware and each handler check it. Admin paths require a Select staff email. Secrets stay in environment variables. There is no open database policy: the app uses a server-side SQLite file, not client-exposed row security.
- New-order requests are validated with Zod. Carrier fields posted by a client are ignored, and the insert writes the internal carrier columns as SQL NULL.
- The public tracking link is the one unauthenticated endpoint. It is a capability URL, which is the direction discussed for receivers. It is not an open order API.

Staff can still read the text excerpt of a quarantined page, which is where a blocked rate confirmation's dollar amount is visible. That page is admin-only. Releasing it is a deliberate staff action. See the open question about whether a blocked page should be releasable at all.

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
- The PEN site keeps the screenshot spelling "Catersburg, PA". That may be Canonsburg.

## Multi-stop loads

A load is an ordered list of pickups and drops, not only one origin and one destination. The form starts with one of each. Add pickup and Add drop append a stop. Up, Down, and the Drag handle reorder them, including after the load is saved. Remove deletes a stop. Save is blocked unless there is at least one pickup and one drop. If a drop is listed before every pickup, the form shows a warning and still saves, because that sequence is sometimes real.

The first pickup is the origin column and the last drop is the destination column, so the existing table, search, and tracking summary keep working. Intermediate cities are searchable. A receiver sees the load when any drop matches their company, not only the last one. The demo load SO4555 has two pickups and one Enchanted Rock drop. Public tracking lists each stop as city and state only.

### How saved stop edits sync to SAM

They do not sync yet. The running app writes the ordered list to `stops_json` in the mock store. `lib/sam.ts` already has the contract for when credentials arrive:

- Create sends `toSamStops`: the full list with `sequence` 1..n, type Pickup or Delivery, and the address. The first pickup carries the ship date and time. The last drop carries the must-deliver date. No carrier fields are included.
- A later edit sends that same full list again via `SamTmsClient.replaceStops`, a PUT to `/v1/loads/{loadNumber}/stops`. SAM is expected to replace the load's stops in that order. The portal does not send a diff, so a removed stop disappears and a reordered stop keeps its new index.
- Reading a SAM order maps every stop back onto `stops`. The first pickup and the last delivery still fill origin and destination. Extra keys on a SAM stop, including a carrier rate, are dropped by the customer serializer.

Those HTTP paths are still a placeholder. Wiring `submitOrder` and `updateOrder` to call the client is the change to make when Mike's API contract is confirmed. Until then, a saved edit is only in `portal.db`.

## Data layer and SAM

`lib/orders.ts` is the store the app uses today: list, get, submit, update, stats, all returning the customer-safe shape. Submit writes the order there and sends the confirmation. There is no Slack step.

`lib/sam.ts` is the drop-in HTTP client. `pickCustomerRate` reads `customerRate` or `customerCharges.lineHaul` / `customerCharges.customerTotal` and never falls back to `carrierCost`. `toSamCreatePayload` does not include carrier fields. The paths (`/v1/customers/{id}/orders`) are a placeholder. The client is unit-tested with a fixture that includes carrier cost 8765.43 and customer rate 1500. It is not called by the running routes. Wiring it is the change to make when Mike's credentials and the real paths arrive. Until then, orders "in SAM" means rows in `data/portal.db`.

Documents, users, the review queue, and the outbox stay in that database even after orders move to SAM.

## Auth

Two providers, on purpose. Select does not use Microsoft.

- **Microsoft (Entra ID)** is for EMIT staff and for receivers. An EMIT domain (`EMIT_EMAIL_DOMAINS`, default `emit.example`, `emit.com`, `emittechnologies.com`) or an address in `EMIT_ALLOWED_EMAILS` sees every EMIT load. Any other Microsoft account is a receiver only when Settings → Receivers maps their email or domain to a destination company. A Select address is rejected and told to use Google.
- **Google** is for Select staff. The Workspace hosted domain is `goselect.com`. The only admins are `mgray@goselect.com` (Mike Gray) and `dmartin@goselect.com` (Drew Martin), from `SELECT_ADMIN_EMAILS`. Any other Google account is rejected. EMIT addresses are rejected and told to use Microsoft. There is no EMIT admin role.
- **Password** is the demo and local path (bcrypt). Demo password is `Emit-Demo-2026` unless `DEMO_USER_PASSWORD` is set. Production rejects passwords unless `DEMO_SEED=true` or `ALLOW_PASSWORD_LOGIN=true`.
- No self-service signup and no password reset.

### What Mike needs to create

Microsoft, in EMIT's Entra admin (or a dedicated portal tenant):

- App registration, type Web.
- Redirect URI: `{PORTAL_PUBLIC_URL}/api/auth/microsoft/callback`
- Delegated scopes: `openid`, `profile`, `email`
- A client secret. Put the tenant id, client id, and secret in `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`.
- If receivers live in EMIT's tenant as guests, the tenant id is EMIT's directory. If they sign in from their own Microsoft 365, set `AZURE_AD_TENANT_ID` to `organizations` and register the app as multi-tenant (accounts in any organizational directory).

Google, in Select's Google Cloud project, OAuth consent screen set to **Internal** (goselect.com only):

- OAuth client type: Web application.
- Authorized redirect URI: `{PORTAL_PUBLIC_URL}/api/auth/google/callback`
- Authorized JavaScript origin: the origin of `PORTAL_PUBLIC_URL` (scheme + host, no path).
- Scopes: `openid`, `email`, `profile`
- Client id and secret go in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. `GOOGLE_HOSTED_DOMAIN` stays `goselect.com`.

The portal also sends `hd=goselect.com` so the Google screen prefers the Select Workspace.

## Deploy

This environment has no public host, so there is no test URL. The production build was run locally on http://127.0.0.1:3000.

The process needs a long-lived Node 22 server and a disk for `data/portal.db`. It is not a serverless app: the review queue, users, and files live in that database.

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

Set `DEMO_SEED=false` before any real EMIT user can sign in. In production the seed stays off unless `DEMO_SEED=true` is explicit. `AUTH_SECRET` shorter than 16 characters throws on startup in production.

Turn off the on-screen demo hint with `NEXT_PUBLIC_DEMO_HINT=false` once real users arrive. That variable is public by design; it only hides the banner.

## Environment variables still needed

| Variable | Who provides it | Used for |
| --- | --- | --- |
| `AUTH_SECRET` | Select, generate a long random string | Session signing. Required in production. |
| `PORTAL_PUBLIC_URL` | Whoever hosts the test site | Links in confirmation email and tracking. |
| `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET` | Mike, Entra app registration | Microsoft 365 sign-in. |
| `SELECT_ADMIN_EMAILS` | Defaults to `mgray@goselect.com,dmartin@goselect.com`. Change only if those addresses change. |
| `EMIT_EMAIL_DOMAINS` or `EMIT_ALLOWED_EMAILS` | Mike | Which Microsoft users are EMIT staff (all loads), not receivers. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Select Google Cloud, internal OAuth client | Select staff sign-in. |
| `GOOGLE_HOSTED_DOMAIN` | Default `goselect.com` | Workspace domain check. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Select email | Confirmation mail. Without these, the message is only in the outbox and on screen. |
| `AI_API_KEY`, optional `AI_BASE_URL`, `AI_MODEL` | Select | OpenAI-compatible chat. Blank uses the built-in answerer. |
| `SAM_API_BASE_URL`, `SAM_API_TOKEN`, `SAM_CUSTOMER_ID` | Mike, already requested | Live orders. Not connected until the HTTP contract is confirmed. |

`PORTAL_DB_PATH` defaults to `./data/portal.db`.

## Assumptions

- The Cost field on a load is EMIT's rate with Select, which the old portal showed. It is not carrier pay. It is visible to EMIT. Carrier name, MC, pay, margin, and rate-confirmation status are omitted from customer and from the admin order payload. Staff see carrier-pay text only in the quarantine excerpt.
- "This week" is Monday through Sunday in America/Denver.
- Ship and appointment times are Denver wall-clock times.
- Google Maps is a search link. There is no Maps API key.
- Uploads are not virus-scanned. Max 8 MB and 25 pages.
- A page the screener cannot read is held, including photos and Word files.
- Cancelled loads stay on the dashboard and can be filtered.
- A receiver is a Microsoft user whose email or domain is in the receiver directory. They see loads whose destination company matches that entry, including released BOLs and PODs, and not EMIT's cost or rate-reason code. EMIT staff still see every load and the cost. The demo maps `enchantedrock.example` to Enchanted Rock LLC.
- The public tracking link is still a per-load capability URL. It does not list other loads. It is not tied to the receiver's Microsoft session.
- Demo tracking tokens are `sha256("emit-demo:" + loadNumber)` and are predictable. New orders use 24 random bytes.
- Load numbers 900181–900204 and the carrier sentinels are fake.
- Approving a blocked rate confirmation is allowed, with the excerpt in front of the admin, so a false positive can be released. That is a product choice, not a silent bypass.
- The SAM HTTP paths are a guess and must be replaced with the real contract. Customer responses would still pass through the same serializer.

## Open questions for Mike

Answered: EMIT staff and receivers sign in with Microsoft. Select staff sign in with Google. The only admins are Mike Gray (`mgray@goselect.com`) and Drew Martin (`dmartin@goselect.com`). There is no EMIT admin role.

1. SAM base URL, auth scheme, EMIT's customer id, and the real endpoints. Does creating a shipment create the order and the first load together, the way the portal does now?
2. Confirm Cost is the sell rate EMIT staff should keep seeing. Receivers do not see it. Carrier pay stays off the order for everyone and is visible to Select only inside a quarantined document.
3. Should confirmation email go through SMTP, or through a Select mailbox? Google is Select's identity provider, so the Gmail API is a possible sender. Microsoft Graph would send as an EMIT mailbox.
4. Which model should answer questions once a key exists?
5. Should a page the screener marks as a rate confirmation be impossible to release, or is one Select admin's approval enough?
6. Is the PEN address Catersburg or Canonsburg, Pennsylvania?
7. Which receiver companies and email domains should be in the directory at launch? The demo only has Enchanted Rock LLC / `enchantedrock.example`. A receiver matches any drop on the load, not only the last one. The company string has to match that drop.
8. Do receivers sign in as guests in EMIT's Entra tenant, or from their own Microsoft 365 tenants? That chooses EMIT's tenant id versus `organizations`.
9. Enchanted Rock's spreadsheet view is still later. A signed-in receiver currently gets the filtered load list, not a separate grid.
10. When the 587 loads are migrated, should historical documents be screened the same way, and who reviews that queue?
11. Where should the test host live, and who owns DNS when a real hostname is wanted?
12. Is demo password sign-in acceptable until the OAuth apps exist, and should it be removed after that?
