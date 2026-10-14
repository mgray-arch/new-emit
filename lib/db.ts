import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface PortalContext {
  db: DatabaseSync;
  now: () => Date;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('customer', 'admin', 'receiver')),
  password_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  address1 TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'US',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS loads (
  id TEXT PRIMARY KEY,
  sales_order_number TEXT NOT NULL,
  load_number TEXT NOT NULL UNIQUE,
  portal_status TEXT NOT NULL,
  tracking_stage TEXT NOT NULL,
  timeline_json TEXT NOT NULL,
  origin_json TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  stops_json TEXT,
  truck_type TEXT,
  transit TEXT,
  ship_date TEXT,
  ship_time TEXT,
  must_deliver_date TEXT,
  truck_eta TEXT,
  latest_eta TEXT,
  tracking_token TEXT NOT NULL UNIQUE,
  customer_cost_cents INTEGER,
  rate_reason TEXT,
  comments TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pending_review_count INTEGER NOT NULL DEFAULT 0,
  carrier_pay_cents INTEGER,
  carrier_name TEXT,
  carrier_mc TEXT,
  staff_notes TEXT
);

CREATE TABLE IF NOT EXISTS customer_documents (
  id TEXT PRIMARY KEY,
  load_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS internal_documents (
  id TEXT PRIMARY KEY,
  load_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  screen_result TEXT NOT NULL,
  screen_reason TEXT NOT NULL,
  review_status TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  page_index INTEGER NOT NULL,
  page_count INTEGER NOT NULL,
  text_excerpt TEXT,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  load_id TEXT,
  created_at TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS loads_ship_date ON loads(ship_date);
CREATE INDEX IF NOT EXISTS loads_status ON loads(portal_status);
CREATE INDEX IF NOT EXISTS loads_so ON loads(sales_order_number);
CREATE INDEX IF NOT EXISTS customer_docs_load ON customer_documents(load_id);
CREATE INDEX IF NOT EXISTS internal_docs_load ON internal_documents(load_id);
CREATE INDEX IF NOT EXISTS internal_docs_review ON internal_documents(review_status);

CREATE TABLE IF NOT EXISTS carrier_photos (
  id TEXT PRIMARY KEY,
  load_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  source TEXT NOT NULL,
  subject TEXT,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  held INTEGER NOT NULL DEFAULT 0,
  hold_reason TEXT,
  bytes BLOB NOT NULL,
  UNIQUE (load_id, sha256)
);

CREATE INDEX IF NOT EXISTS carrier_photos_load ON carrier_photos(load_id, received_at);

CREATE TABLE IF NOT EXISTS receiver_access (
  id TEXT PRIMARY KEY,
  match_value TEXT NOT NULL UNIQUE,
  company TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/**
 * Columns a customer query is allowed to read. Carrier pay and staff notes are
 * stored on the row for the SAM sync, and they are intentionally absent here.
 */
export const CUSTOMER_LOAD_COLUMNS = `
  id, sales_order_number, load_number, portal_status, tracking_stage, timeline_json,
  origin_json, destination_json, stops_json, truck_type, transit, ship_date, ship_time,
  must_deliver_date, truck_eta, latest_eta, tracking_token, customer_cost_cents,
  rate_reason, comments, created_by, created_at, updated_at, pending_review_count
`;

export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrateUserRoles(db);
  migrateStops(db);
  return db;
}

function migrateStops(db: DatabaseSync): void {
  const columns = db.prepare(`PRAGMA table_info(loads)`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "stops_json")) {
    db.exec(`ALTER TABLE loads ADD COLUMN stops_json TEXT`);
  }
  db.exec(`
    UPDATE loads
    SET stops_json = json_array(
      json_object('id', 'stop-1', 'kind', 'pickup', 'place', json(origin_json)),
      json_object('id', 'stop-2', 'kind', 'drop', 'place', json(destination_json))
    )
    WHERE stops_json IS NULL OR stops_json = ''
  `);
}

/** Older databases restricted role to customer|admin. Rebuild that table in place. */
function migrateUserRoles(db: DatabaseSync): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`).get() as
    | { sql: string }
    | undefined;
  if (!row || row.sql.includes("'receiver'")) return;
  db.exec(`
    CREATE TABLE users_migrated (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('customer', 'admin', 'receiver')),
      password_hash TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO users_migrated (id, email, name, role, password_hash, created_at)
      SELECT id, email, name, role, password_hash, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_migrated RENAME TO users;
  `);
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already closed */
    }
    throw error;
  }
}

type GlobalPortal = typeof globalThis & {
  __portal?: PortalContext;
  __portalTest?: PortalContext;
  __portalSeed?: Promise<void>;
};

function globals(): GlobalPortal {
  return globalThis as GlobalPortal;
}

export function useTestPortal(ctx: PortalContext | null): void {
  if (process.env.PORTAL_TEST_MODE !== "1" || process.env.NODE_ENV === "production") {
    throw new Error("Test portal override is disabled");
  }
  const g = globals();
  if (ctx) g.__portalTest = ctx;
  else delete g.__portalTest;
}

export function getPortalContext(): PortalContext {
  const g = globals();
  if (process.env.PORTAL_TEST_MODE === "1" && process.env.NODE_ENV !== "production" && g.__portalTest) {
    return g.__portalTest;
  }
  if (!g.__portal) {
    const file = process.env.PORTAL_DB_PATH || path.join(process.cwd(), "data", "portal.db");
    g.__portal = { db: openDatabase(file), now: () => new Date() };
  }
  return g.__portal;
}

export function demoSeedEnabled(): boolean {
  if (process.env.DEMO_SEED === "true") return true;
  if (process.env.DEMO_SEED === "false") return false;
  return process.env.NODE_ENV !== "production";
}
