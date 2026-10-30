import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Client, ResultSet, Row, Transaction, Value } from "@libsql/client";
import { writeStoredBytes } from "@/lib/storage";

export type SqlArg = string | number | bigint | Uint8Array | null;

export interface SqlStatement {
  get(...params: SqlArg[]): Promise<Record<string, unknown> | undefined>;
  all(...params: SqlArg[]): Promise<Record<string, unknown>[]>;
  run(...params: SqlArg[]): Promise<{ changes: number }>;
}

export interface SqlDatabase {
  exec(sql: string): Promise<void>;
  prepare(sql: string): SqlStatement;
  close?(): void;
}

export interface PortalContext {
  db: SqlDatabase;
  now: () => Date;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('customer', 'emit_viewer', 'emit_admin', 'admin')),
  permission TEXT CHECK(permission IS NULL OR permission IN ('view', 'add', 'pricing', 'full')),
  password_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  password_changed_at TEXT,
  password_epoch INTEGER NOT NULL DEFAULT 0,
  chat_enabled INTEGER NOT NULL DEFAULT 0,
  profile TEXT,
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
  load_number TEXT UNIQUE,
  load_number_source TEXT,
  source TEXT,
  portal_status TEXT NOT NULL,
  tracking_stage TEXT NOT NULL,
  timeline_json TEXT NOT NULL,
  origin_json TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  stops_json TEXT,
  sales_orders_json TEXT,
  truck_type TEXT,
  transit TEXT,
  ship_date TEXT,
  ship_time TEXT,
  must_deliver_date TEXT,
  truck_eta TEXT,
  latest_eta TEXT,
  tracking_token TEXT NOT NULL UNIQUE,
  tracking_link TEXT,
  tracking_link_source TEXT,
  customer_cost_cents INTEGER,
  rate_reason TEXT,
  comments TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  entered_by_name TEXT,
  entered_by_email TEXT,
  owner TEXT,
  owner_needs_check INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pending_review_count INTEGER NOT NULL DEFAULT 0,
  sam_build_status TEXT,
  sam_build_error TEXT,
  sam_build_at TEXT,
  carrier_name TEXT,
  carrier_mc TEXT,
  driver_name TEXT,
  carrier_updated_at TEXT,
  bol_changed_at TEXT,
  copied_from_id TEXT
);

CREATE TABLE IF NOT EXISTS bol_prints (
  id TEXT PRIMARY KEY,
  load_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  printed_at TEXT NOT NULL,
  printed_by_id TEXT NOT NULL,
  printed_by_name TEXT NOT NULL,
  carrier_name TEXT,
  carrier_mc TEXT,
  driver_name TEXT,
  bol_fingerprint TEXT NOT NULL,
  UNIQUE (load_id, version)
);

CREATE INDEX IF NOT EXISTS bol_prints_load ON bol_prints(load_id, version);

CREATE TABLE IF NOT EXISTS customer_documents (
  id TEXT PRIMARY KEY,
  load_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  uploaded_by TEXT
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
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  uploaded_by TEXT
);

CREATE TABLE IF NOT EXISTS document_uploads (
  id TEXT PRIMARY KEY,
  load_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  filename TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  released_count INTEGER NOT NULL,
  held_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (load_id, sha256)
);

CREATE INDEX IF NOT EXISTS document_uploads_load ON document_uploads(load_id);

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
  storage_key TEXT NOT NULL,
  UNIQUE (load_id, sha256)
);

CREATE INDEX IF NOT EXISTS carrier_photos_load ON carrier_photos(load_id, received_at);

CREATE TABLE IF NOT EXISTS receivers (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  contact_emails TEXT NOT NULL DEFAULT '[]',
  access_token TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS receivers_token ON receivers(access_token);

CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS login_attempts_bucket ON login_attempts(bucket, created_at);

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('drop', 'pickup_once')),
  company TEXT NOT NULL,
  address1 TEXT NOT NULL,
  address2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  postal_code TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'US',
  contact TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  receiver_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS locations_kind ON locations(kind, active, use_count);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  body TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_email TEXT NOT NULL,
  author_side TEXT NOT NULL CHECK(author_side IN ('emit', 'select')),
  load_id TEXT,
  load_number TEXT,
  sales_order_number TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_seq ON messages(seq);

CREATE TABLE IF NOT EXISTS message_reads (
  user_id TEXT PRIMARY KEY,
  read_seq INTEGER NOT NULL
);
`;

/**
 * Every column stored on a load that the portal reads back.
 * Carrier pay is not a column. Carrier name, MC, and driver are identity only.
 */
export const CUSTOMER_LOAD_COLUMNS = `
  id, sales_order_number, load_number, portal_status, tracking_stage, timeline_json,
  origin_json, destination_json, stops_json, sales_orders_json, truck_type, transit, ship_date, ship_time,
  must_deliver_date, truck_eta, latest_eta, tracking_token, tracking_link, customer_cost_cents,
  rate_reason, comments, created_by, entered_by_name, entered_by_email, owner, owner_needs_check, created_at, updated_at, pending_review_count,
  sam_build_status, sam_build_error, sam_build_at,
  carrier_name, carrier_mc, driver_name, carrier_updated_at, bol_changed_at, copied_from_id
`;

function coerce(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}

function coerceRecord(row: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) record[key] = coerce(value);
  return record;
}

class NodeSqliteDatabase implements SqlDatabase {
  constructor(private db: import("node:sqlite").DatabaseSync) {}

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    const stmt = this.db.prepare(sql);
    return {
      get: async (...params) => {
        const row = stmt.get(...(params as import("node:sqlite").SQLInputValue[])) as
          | Record<string, unknown>
          | undefined;
        return row ? coerceRecord(row) : undefined;
      },
      all: async (...params) => {
        const rows = stmt.all(...(params as import("node:sqlite").SQLInputValue[])) as Record<string, unknown>[];
        return rows.map(coerceRecord);
      },
      run: async (...params) => {
        const result = stmt.run(...(params as import("node:sqlite").SQLInputValue[]));
        return { changes: Number(result.changes) };
      },
    };
  }

  close(): void {
    this.db.close();
  }
}

function libsqlRecords(result: ResultSet): Record<string, unknown>[] {
  return result.rows.map((row: Row) => {
    const record: Record<string, unknown> = {};
    const values = row as Row & Record<number | string, Value>;
    result.columns.forEach((name, index) => {
      // Rows are addressable by position and by column name. A missing position
      // still has the named value; SQL NULL is null, so only undefined falls through.
      const byIndex = values[index];
      record[name] = coerce(byIndex !== undefined ? byIndex : values[name]);
    });
    return record;
  });
}

class LibsqlDatabase implements SqlDatabase {
  private tx: Transaction | null = null;

  constructor(private client: Client) {}

  async exec(sql: string): Promise<void> {
    for (const statement of splitSql(sql)) {
      const normalized = statement.replace(/\s+/g, " ").trim().toUpperCase();
      if (normalized === "BEGIN" || normalized === "BEGIN IMMEDIATE" || normalized === "BEGIN TRANSACTION") {
        if (this.tx) throw new Error("Nested transactions are not supported");
        this.tx = await this.client.transaction("write");
        continue;
      }
      if (normalized === "COMMIT") {
        if (!this.tx) throw new Error("No transaction is open");
        const tx = this.tx;
        this.tx = null;
        await tx.commit();
        tx.close();
        continue;
      }
      if (normalized === "ROLLBACK") {
        if (!this.tx) return;
        const tx = this.tx;
        this.tx = null;
        await tx.rollback();
        tx.close();
        continue;
      }
      await (this.tx ?? this.client).execute(statement);
    }
  }

  prepare(sql: string): SqlStatement {
    const run = async (...params: SqlArg[]) => {
      const runner = this.tx ?? this.client;
      return runner.execute({ sql, args: params });
    };
    return {
      get: async (...params) => {
        const result = await run(...params);
        return libsqlRecords(result)[0];
      },
      all: async (...params) => libsqlRecords(await run(...params)),
      run: async (...params) => ({ changes: Number((await run(...params)).rowsAffected) }),
    };
  }
}

function splitSql(sql: string): string[] {
  return sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

async function openNodeSqlite(file: string): Promise<SqlDatabase> {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  return new NodeSqliteDatabase(new DatabaseSync(file));
}

async function openLibsql(url: string, authToken: string | undefined): Promise<SqlDatabase> {
  const { createClient } = await import("@libsql/client");
  return new LibsqlDatabase(createClient({ url, authToken }));
}

/**
 * `:memory:` and file paths use node:sqlite so tests and local dev need no account.
 * TURSO_DATABASE_URL switches the process to hosted libSQL. A memory database ignores that URL.
 */
export async function openDatabase(file?: string): Promise<SqlDatabase> {
  const turso = process.env.TURSO_DATABASE_URL?.trim();
  const useFile = file === ":memory:" || (!turso && !process.env.VERCEL);
  if (process.env.VERCEL && file !== ":memory:" && !turso) {
    throw new Error("TURSO_DATABASE_URL is required on Vercel");
  }
  const db = useFile
    ? await openNodeSqlite(file ?? (process.env.PORTAL_DB_PATH || path.join(process.cwd(), "data", "portal.db")))
    : await openLibsql(turso!, process.env.TURSO_AUTH_TOKEN);
  await db.exec("PRAGMA foreign_keys = ON");
  try {
    await db.exec("PRAGMA busy_timeout = 3000");
  } catch {
    /* Turso accepts the lock wait even when this pragma is a no-op. */
  }
  await recoverInterruptedUserRebuild(db);
  await db.exec(SCHEMA);
  await migrateUserRoles(db);
  await migrateStops(db);
  await ensureColumn(db, "loads", "sales_orders_json", "TEXT");
  await migrateDropCarrierColumns(db);
  await ensureColumn(db, "loads", "carrier_name", "TEXT");
  await ensureColumn(db, "loads", "carrier_mc", "TEXT");
  await ensureColumn(db, "loads", "driver_name", "TEXT");
  await ensureColumn(db, "loads", "carrier_updated_at", "TEXT");
  await ensureColumn(db, "loads", "bol_changed_at", "TEXT");
  await ensureColumn(db, "loads", "copied_from_id", "TEXT");
  await migrateReceivers(db);
  await migrateStoredBytes(db);
  await migrateLoadNumbers(db);
  await migrateTrackingLink(db);
  await migrateUserAccount(db);
  await migrateEmitAdminRole(db);
  await migrateEmitViewerRole(db);
  await migrateEmitPermissions(db);
  await migrateSamBuild(db);
  await migrateEnteredBy(db);
  await migrateLoadOwner(db);
  await migrateDocumentUploaders(db);
  await migrateLoadSource(db);
  await migrateChatEnabled(db);
  await ensureColumn(db, "users", "profile", "TEXT");
  await db.exec(`DROP TABLE IF EXISTS outbox`);
  return db;
}

async function columnNames(db: SqlDatabase, table: string): Promise<string[]> {
  const columns = await db.prepare(`PRAGMA table_info(${table})`).all();
  return columns
    .map((column) => (typeof column.name === "string" ? column.name : ""))
    .filter((name) => name.length > 0);
}

function migrationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * ADD COLUMN is not idempotent in SQLite: a second server that cannot yet see
 * the new column tries the same ALTER and gets "duplicate column name".
 * That used to reject the process cache and every later request on that instance failed.
 */
async function ensureColumn(db: SqlDatabase, table: string, column: string, definition: string): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    throw new Error("Unsafe migration identifier");
  }
  const columns = await columnNames(db, table);
  if (columns.includes(column)) return;
  try {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (/duplicate column/i.test(migrationError(error))) return;
    const again = await columnNames(db, table);
    if (again.includes(column)) return;
    throw error;
  }
}

async function tableSql(db: SqlDatabase, table: string): Promise<string | null> {
  const row = await db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  if (!row) return null;
  return String(row.sql ?? "");
}

async function countRows(db: SqlDatabase, table: string): Promise<number> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error("Unsafe migration identifier");
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return Number(row?.n ?? 0);
}

/**
 * A role rebuild copies users, drops the old table, then renames the copy.
 * If the process dies after the drop, the next boot must rename the copy
 * before CREATE TABLE IF NOT EXISTS builds an empty users table over it.
 */
async function recoverInterruptedUserRebuild(db: SqlDatabase): Promise<void> {
  if (await tableSql(db, "users")) return;
  for (const table of ["users_emit_viewer", "users_emit_admin", "users_migrated"] as const) {
    if (!(await tableSql(db, table))) continue;
    await db.exec(`ALTER TABLE ${table} RENAME TO users`);
    return;
  }
}

async function migrateStops(db: SqlDatabase): Promise<void> {
  await ensureColumn(db, "loads", "stops_json", "TEXT");
  await db.exec(`
    UPDATE loads
    SET stops_json = json_array(
      json_object('id', 'stop-1', 'kind', 'pickup', 'place', json(origin_json)),
      json_object('id', 'stop-2', 'kind', 'drop', 'place', json(destination_json))
    )
    WHERE stops_json IS NULL OR stops_json = ''
  `);
}

const CARRIER_COLUMNS = ["carrier_pay_cents", "staff_notes"];

/**
 * Carrier pay and staff notes are not stored. Carrier name, MC, and driver
 * stay: they identify who is hauling the load and are not pay.
 */
async function migrateDropCarrierColumns(db: SqlDatabase): Promise<void> {
  const columns = await columnNames(db, "loads");
  for (const name of CARRIER_COLUMNS) {
    if (!columns.includes(name)) continue;
    try {
      await db.exec(`ALTER TABLE loads DROP COLUMN ${name}`);
    } catch (error) {
      if (/no such column/i.test(migrationError(error))) continue;
      throw error;
    }
  }
}

/**
 * Older databases required a load number, and the portal filled in a fake one.
 * A missing Select load number is NULL so many orders can be pending at once.
 */
async function migrateLoadNumbers(db: SqlDatabase): Promise<void> {
  const columns = await db.prepare(`PRAGMA table_info(loads)`).all();
  const loadColumn = columns.find((column) => column.name === "load_number");
  const hasSource = columns.some((column) => column.name === "load_number_source");
  if (loadColumn && Number(loadColumn.notnull) === 0 && hasSource) return;
  if (loadColumn && Number(loadColumn.notnull) === 0 && !hasSource) {
    await db.exec(`ALTER TABLE loads ADD COLUMN load_number_source TEXT`);
    return;
  }
  await db.exec(`
    CREATE TABLE loads_migrated (
      id TEXT PRIMARY KEY,
      sales_order_number TEXT NOT NULL,
      load_number TEXT UNIQUE,
      load_number_source TEXT,
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
  tracking_link TEXT,
  tracking_link_source TEXT,
  customer_cost_cents INTEGER,
  rate_reason TEXT,
  comments TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pending_review_count INTEGER NOT NULL DEFAULT 0
);
    INSERT INTO loads_migrated (
      id, sales_order_number, load_number, load_number_source, portal_status, tracking_stage, timeline_json,
      origin_json, destination_json, stops_json, truck_type, transit, ship_date, ship_time,
      must_deliver_date, truck_eta, latest_eta, tracking_token, customer_cost_cents,
      rate_reason, comments, created_by, created_at, updated_at, pending_review_count
    )
    SELECT
      id, sales_order_number, NULLIF(load_number, ''), NULL, portal_status, tracking_stage, timeline_json,
      origin_json, destination_json, stops_json, truck_type, transit, ship_date, ship_time,
      must_deliver_date, truck_eta, latest_eta, tracking_token, customer_cost_cents,
      rate_reason, comments, created_by, created_at, updated_at, pending_review_count
    FROM loads;
    DROP TABLE loads;
    ALTER TABLE loads_migrated RENAME TO loads;
    CREATE INDEX IF NOT EXISTS loads_ship_date ON loads(ship_date);
    CREATE INDEX IF NOT EXISTS loads_status ON loads(portal_status);
    CREATE INDEX IF NOT EXISTS loads_so ON loads(sales_order_number);
  `);
}

async function migrateUserAccount(db: SqlDatabase): Promise<void> {
  await ensureColumn(db, "users", "active", "INTEGER NOT NULL DEFAULT 1");
  await ensureColumn(db, "users", "password_changed_at", "TEXT");
  await ensureColumn(db, "users", "password_epoch", "INTEGER NOT NULL DEFAULT 0");
}

const BYTE_TABLES = [
  ["customer_documents", "customer-documents"],
  ["internal_documents", "internal-documents"],
  ["carrier_photos", "carrier-photos"],
] as const;

/** Older databases kept file bytes in SQLite. Copy them out, then drop the column. */
async function migrateStoredBytes(db: SqlDatabase): Promise<void> {
  for (const [table, prefix] of BYTE_TABLES) {
    const columns = await columnNames(db, table);
    if (!columns.includes("bytes")) continue;
    if (!columns.includes("storage_key")) await ensureColumn(db, table, "storage_key", "TEXT");
    const rows = await db.prepare(`SELECT id, bytes, storage_key FROM ${table}`).all();
    for (const row of rows) {
      if (row.storage_key) continue;
      const id = String(row.id);
      const raw = row.bytes;
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array();
      const locator = await writeStoredBytes(`${prefix}/${id}`, bytes, "application/octet-stream", { overwrite: true });
      await db.prepare(`UPDATE ${table} SET storage_key = ? WHERE id = ?`).run(locator, id);
    }
    await db.exec(`ALTER TABLE ${table} DROP COLUMN bytes`);
  }
}

/**
 * Receiver login rows become companies with a private link.
 * Contact values that are email addresses are kept. Domain-only rows are not emails.
 */
async function migrateReceivers(db: SqlDatabase): Promise<void> {
  const legacy = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'receiver_access'`).get();
  if (!legacy) return;
  const rows = await db.prepare(`SELECT match_value, company, created_at FROM receiver_access`).all();
  const grouped = new Map<string, { emails: string[]; createdAt: string }>();
  for (const row of rows) {
    const company = String(row.company).trim();
    const createdAt = String(row.created_at);
    const current = grouped.get(company) ?? { emails: [], createdAt };
    const match = String(row.match_value);
    if (match.includes("@")) current.emails.push(match.trim().toLowerCase());
    if (createdAt < current.createdAt) current.createdAt = createdAt;
    grouped.set(company, current);
  }
  for (const [company, info] of grouped) {
    const existing = await db.prepare(`SELECT id FROM receivers WHERE LOWER(company) = LOWER(?)`).get(company);
    if (existing) continue;
    const now = info.createdAt || new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO receivers (id, company, contact_emails, access_token, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        randomBytes(16).toString("hex"),
        company,
        JSON.stringify([...new Set(info.emails)]),
        randomBytes(32).toString("base64url"),
        now,
        now,
      );
  }
  await db.exec(`DROP TABLE receiver_access`);
}

interface UserRebuild {
  marker: string;
  table: string;
  check: string;
}

/**
 * Permission is separate from EMIT admin vs regular.
 * Older rows: view-only role, add-loads customer, and full-access admin get the matching permission.
 * The role itself stays so an existing view-only account does not change shape under a live session.
 */
async function migrateEmitPermissions(db: SqlDatabase): Promise<void> {
  await ensureColumn(db, "users", "permission", "TEXT");
  await db.exec(`
    UPDATE users SET permission = 'view' WHERE role = 'emit_viewer' AND permission IS NULL;
    UPDATE users SET permission = 'add' WHERE role = 'customer' AND permission IS NULL;
    UPDATE users SET permission = 'full' WHERE role = 'emit_admin' AND permission IS NULL;
  `);
}

/** View only is a fourth EMIT role. Existing add-loads users stay `customer`. Full access stays `emit_admin`. */
async function migrateEmitViewerRole(db: SqlDatabase): Promise<void> {
  await rebuildUsersForRole(db, {
    marker: "'emit_viewer'",
    table: "users_emit_viewer",
    check: "'customer', 'emit_viewer', 'emit_admin', 'admin'",
  });
}

async function migrateSamBuild(db: SqlDatabase): Promise<void> {
  await ensureColumn(db, "loads", "sam_build_status", "TEXT");
  await ensureColumn(db, "loads", "sam_build_error", "TEXT");
  await ensureColumn(db, "loads", "sam_build_at", "TEXT");
}

/** Who typed the load in. Null on rows saved before this column existed. */
async function migrateEnteredBy(db: SqlDatabase): Promise<void> {
  await ensureColumn(db, "loads", "entered_by_name", "TEXT");
  await ensureColumn(db, "loads", "entered_by_email", "TEXT");
}

/** Select owner. Null on rows saved before this column existed. EMIT never receives it. */
async function migrateLoadOwner(db: SqlDatabase): Promise<void> {
  await ensureColumn(db, "loads", "owner", "TEXT");
  await ensureColumn(db, "loads", "owner_needs_check", "INTEGER NOT NULL DEFAULT 0");
}

/** Older databases only allowed customer and Select admin. EMIT admin is a third role. */
async function migrateEmitAdminRole(db: SqlDatabase): Promise<void> {
  await rebuildUsersForRole(db, {
    marker: "'emit_admin'",
    table: "users_emit_admin",
    check: "'customer', 'emit_admin', 'admin'",
  });
}

async function rebuildUsersForRole(db: SqlDatabase, spec: UserRebuild): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.table)) throw new Error("Unsafe migration identifier");
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rebuildUsersForRoleOnce(db, spec);
      return;
    } catch (error) {
      if (attempt === 4 || !/already exists|database is locked|SQLITE_BUSY/i.test(migrationError(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

async function rebuildUsersForRoleOnce(db: SqlDatabase, spec: UserRebuild): Promise<void> {
  const liveSql = await tableSql(db, "users");
  const partialSql = await tableSql(db, spec.table);
  const liveCount = liveSql ? await countRows(db, "users") : 0;
  const partialCount = partialSql ? await countRows(db, spec.table) : 0;

  if (liveSql?.includes(spec.marker)) {
    // SCHEMA can recreate an empty users table after a crash. The copy still has the accounts.
    if (liveCount === 0 && partialCount > 0) {
      await db.exec(`DROP TABLE users`);
      await db.exec(`ALTER TABLE ${spec.table} RENAME TO users`);
    } else if (partialSql) {
      await db.exec(`DROP TABLE ${spec.table}`);
    }
    return;
  }

  if (!liveSql && partialSql) {
    await db.exec(`ALTER TABLE ${spec.table} RENAME TO users`);
    return;
  }
  if (!liveSql) return;
  if (partialSql) await db.exec(`DROP TABLE ${spec.table}`);

  await db.exec(`
      CREATE TABLE ${spec.table} (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN (${spec.check})),
        password_hash TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        password_changed_at TEXT,
        password_epoch INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      INSERT INTO ${spec.table} (
        id, email, name, role, password_hash, active, password_changed_at, password_epoch, created_at
      )
      SELECT
        id, email, name, role, password_hash,
        COALESCE(active, 1), password_changed_at, COALESCE(password_epoch, 0), created_at
      FROM users;
      DROP TABLE users;
      ALTER TABLE ${spec.table} RENAME TO users;
    `);
}

/**
 * Null means the load was entered in the portal. `sam-import` means the historical
 * SAM import created it. A portal load is never relabeled, so a re-import cannot overwrite it.
 */
async function migrateLoadSource(db: SqlDatabase): Promise<void> {
  await ensureColumn(db, "loads", "source", "TEXT");
}

/** EMIT chat is off until Select turns it on. Select staff are not gated by this column. */
async function migrateChatEnabled(db: SqlDatabase): Promise<void> {
  await ensureColumn(db, "users", "chat_enabled", "INTEGER NOT NULL DEFAULT 0");
}

/** Older document tables have no uploader. The bot upload log is created with the schema. */
async function migrateDocumentUploaders(db: SqlDatabase): Promise<void> {
  for (const table of ["customer_documents", "internal_documents"] as const) {
    const columns = await columnNames(db, table);
    if (!columns.includes("uploaded_by")) await ensureColumn(db, table, "uploaded_by", "TEXT");
  }
}

async function migrateTrackingLink(db: SqlDatabase): Promise<void> {
  await ensureColumn(db, "loads", "tracking_link", "TEXT");
  await ensureColumn(db, "loads", "tracking_link_source", "TEXT");
}

/** Databases that allowed a receiver login role drop those users. */
async function migrateUserRoles(db: SqlDatabase): Promise<void> {
  const row = await db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`).get();
  const sql = String(row?.sql ?? "");
  if (!sql.includes("'receiver'")) return;
  await db.exec(`
    CREATE TABLE users_migrated (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('customer', 'emit_admin', 'admin')),
      password_hash TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      password_changed_at TEXT,
      password_epoch INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    INSERT INTO users_migrated (id, email, name, role, password_hash, created_at)
      SELECT id, email, name, role, password_hash, created_at FROM users
      WHERE role IN ('customer', 'admin');
    DROP TABLE users;
    ALTER TABLE users_migrated RENAME TO users;
  `);
}

export async function withTransaction<T>(db: SqlDatabase, fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN IMMEDIATE");
  try {
    const result = await fn();
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {
      /* already closed */
    }
    throw error;
  }
}

type GlobalPortal = typeof globalThis & {
  __portalPromise?: Promise<PortalContext>;
  __portalTest?: PortalContext;
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

export async function getPortalContext(): Promise<PortalContext> {
  const g = globals();
  if (process.env.PORTAL_TEST_MODE === "1" && process.env.NODE_ENV !== "production" && g.__portalTest) {
    return g.__portalTest;
  }
  if (!g.__portalPromise) {
    let pending!: Promise<PortalContext>;
    pending = openDatabase()
      .then((db) => ({ db, now: () => new Date() }))
      .catch((error: unknown) => {
        if (g.__portalPromise === pending) delete g.__portalPromise;
        throw error;
      });
    g.__portalPromise = pending;
  }
  return g.__portalPromise;
}

export function demoSeedEnabled(): boolean {
  if (process.env.DEMO_SEED === "true") return true;
  if (process.env.DEMO_SEED === "false") return false;
  return process.env.NODE_ENV !== "production";
}
