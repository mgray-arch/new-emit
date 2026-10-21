import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { GET as listOrdersRoute } from "@/app/api/orders/route";
import { openDatabase, useTestPortal, type PortalContext, type SqlDatabase } from "@/lib/db";
import { listBoard } from "@/lib/orders";
import type { PortalRole, Session } from "@/lib/types";
import { sessionCookie } from "./helpers";

const USERS = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('customer', 'emit_admin', 'admin')),
  password_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  password_changed_at TEXT,
  password_epoch INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);`;

const LOADS = `
CREATE TABLE loads (
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
);`;

const USER_ROWS = `
INSERT INTO users (id, email, name, role, active, password_epoch, created_at) VALUES
  ('u-add','m.gray@emit.example','M. Gray','customer',1,0,'2026-10-14T18:00:00.000Z'),
  ('u-full','lead@emit.example','EMIT Lead','emit_admin',1,0,'2026-10-14T18:00:00.000Z'),
  ('u-select','mgray@goselect.com','Mike Gray','admin',1,0,'2026-10-14T18:00:00.000Z');`;

const LOAD_ROW = `
INSERT INTO loads (
  id, sales_order_number, load_number, portal_status, tracking_stage, timeline_json,
  origin_json, destination_json, stops_json, tracking_token, customer_cost_cents, comments, created_by, created_at, updated_at, ship_date
) VALUES (
  'l1','SO2196','900196-1','shipped','in_transit','[]',
  '{"company":"EMIT ALLEN","address1":"1","city":"Sheridan","state":"WY","postalCode":"82801","country":"US"}',
  '{"company":"Kodiak","address1":"2","city":"Oklahoma City","state":"OK","postalCode":"73132","country":"US"}',
  '[{"id":"stop-1","kind":"pickup","place":{"company":"EMIT ALLEN","address1":"1","city":"Sheridan","state":"WY","postalCode":"82801","country":"US"}},{"id":"stop-2","kind":"drop","place":{"company":"Kodiak","address1":"2","city":"Oklahoma City","state":"OK","postalCode":"73132","country":"US"}}]',
  'tok1',175000,'','M. Gray','2026-10-14T18:00:00.000Z','2026-10-14T18:00:00.000Z','2026-10-14'
);`;

const NEW_USERS = `
CREATE TABLE users_emit_viewer (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('customer', 'emit_viewer', 'emit_admin', 'admin')),
  password_hash TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  password_changed_at TEXT,
  password_epoch INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);`;

describe("preview database upgrade", () => {
  const dirs: string[] = [];
  const previousUrl = process.env.TURSO_DATABASE_URL;
  const previousToken = process.env.TURSO_AUTH_TOKEN;

  afterEach(() => {
    useTestPortal(null);
    if (previousUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
    else process.env.TURSO_AUTH_TOKEN = previousToken;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function freshFile(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "emit-upgrade-"));
    dirs.push(dir);
    return path.join(dir, "preview.db");
  }

  function writeOld(file: string, sql: string) {
    const raw = new DatabaseSync(file);
    raw.exec(sql);
    raw.close();
  }

  async function openUpgraded(file: string, driver: "sqlite" | "libsql"): Promise<SqlDatabase> {
    if (driver === "libsql") {
      process.env.TURSO_DATABASE_URL = `file:${file}`;
      delete process.env.TURSO_AUTH_TOKEN;
      return openDatabase();
    }
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    return openDatabase(file);
  }

  async function expectLoads(db: SqlDatabase) {
    const columns = (await db.prepare(`PRAGMA table_info(loads)`).all()).map((column) => String(column.name));
    expect(columns).toEqual(expect.arrayContaining(["sam_build_status", "sam_build_error", "sam_build_at"]));
    const ctx: PortalContext = { db, now: () => new Date("2026-10-21T18:00:00Z") };
    for (const tab of ["attention", "active", "delivered", "history"] as const) {
      const board = await listBoard(ctx, { tab, page: 1, pageSize: 25 });
      expect(board.counts.attention + board.counts.active + board.counts.delivered + board.counts.history).toBe(1);
    }
    const attention = await listBoard(ctx, { tab: "attention", page: 1, pageSize: 25 });
    expect(attention.orders.map((order) => order.salesOrderNumber)).toEqual(["SO2196"]);
    const saved = await db.prepare(`SELECT email, role FROM users ORDER BY email`).all();
    expect(saved).toEqual([
      { email: "lead@emit.example", role: "emit_admin" },
      { email: "m.gray@emit.example", role: "customer" },
      { email: "mgray@goselect.com", role: "admin" },
    ]);
  }

  it.each(["sqlite", "libsql"] as const)("lists the existing load after upgrading a pre-permission database (%s)", async (driver) => {
    const file = freshFile();
    writeOld(file, `${USERS}${LOADS}${USER_ROWS}${LOAD_ROW}`);
    const db = await openUpgraded(file, driver);
    await expectLoads(db);
    const again = await openUpgraded(file, driver);
    await expectLoads(again);
  });

  it.each(["sqlite", "libsql"] as const)("keeps accounts when a role rebuild was interrupted (%s)", async (driver) => {
    const file = freshFile();
    writeOld(
      file,
      `${LOADS}${LOAD_ROW}
      ${NEW_USERS}
      INSERT INTO users_emit_viewer (id, email, name, role, active, password_epoch, created_at) VALUES
        ('u-add','m.gray@emit.example','M. Gray','customer',1,0,'2026-10-14T18:00:00.000Z'),
        ('u-full','lead@emit.example','EMIT Lead','emit_admin',1,0,'2026-10-14T18:00:00.000Z'),
        ('u-select','mgray@goselect.com','Mike Gray','admin',1,0,'2026-10-14T18:00:00.000Z');`,
    );
    const db = await openUpgraded(file, driver);
    await expectLoads(db);
  });

  it("restores accounts if an empty users table was created over the copy", async () => {
    const file = freshFile();
    writeOld(
      file,
      `${LOADS}${LOAD_ROW}
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('customer', 'emit_viewer', 'emit_admin', 'admin')),
        password_hash TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        password_changed_at TEXT,
        password_epoch INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      ${NEW_USERS}
      INSERT INTO users_emit_viewer (id, email, name, role, active, password_epoch, created_at) VALUES
        ('u-add','m.gray@emit.example','M. Gray','customer',1,0,'2026-10-14T18:00:00.000Z'),
        ('u-full','lead@emit.example','EMIT Lead','emit_admin',1,0,'2026-10-14T18:00:00.000Z'),
        ('u-select','mgray@goselect.com','Mike Gray','admin',1,0,'2026-10-14T18:00:00.000Z');`,
    );
    const db = await openUpgraded(file, "libsql");
    await expectLoads(db);
  });

  it("upgrades the same old database from overlapping servers and serves every role", async () => {
    const file = freshFile();
    writeOld(file, `${USERS}${LOADS}${USER_ROWS}${LOAD_ROW}`);
    process.env.TURSO_DATABASE_URL = `file:${file}`;
    delete process.env.TURSO_AUTH_TOKEN;
    // Overlapping servers race the first upgrade. A later open has to finish it.
    await Promise.allSettled([openDatabase(), openDatabase(), openDatabase()]);
    const db = await openDatabase();
    await db
      .prepare(
        `INSERT INTO users (id, email, name, role, active, password_epoch, created_at) VALUES ('u-view','viewer@emit.example','View Only','emit_viewer',1,0,'2026-10-14T18:00:00.000Z')`,
      )
      .run();
    const ctx: PortalContext = { db, now: () => new Date("2026-10-21T18:00:00Z") };
    useTestPortal(ctx);

    const cases: Array<{ role: PortalRole; userId: string; email: string; viewAs?: PortalRole; pricing: boolean; review: boolean }> = [
      { role: "customer", userId: "u-add", email: "m.gray@emit.example", pricing: false, review: false },
      { role: "emit_viewer", userId: "u-view", email: "viewer@emit.example", pricing: false, review: false },
      { role: "emit_admin", userId: "u-full", email: "lead@emit.example", pricing: true, review: false },
      { role: "admin", userId: "u-select", email: "mgray@goselect.com", pricing: true, review: true },
      { role: "admin", userId: "u-select", email: "mgray@goselect.com", viewAs: "customer", pricing: false, review: false },
      { role: "admin", userId: "u-select", email: "mgray@goselect.com", viewAs: "emit_viewer", pricing: false, review: false },
      { role: "admin", userId: "u-select", email: "mgray@goselect.com", viewAs: "emit_admin", pricing: true, review: false },
    ];

    for (const item of cases) {
      const session: Session = { userId: item.userId, email: item.email, name: item.email, role: item.role, passwordEpoch: 0 };
      const cookie = await sessionCookie(session);
      const view = item.viewAs ? `; portal_view_as=${item.viewAs}` : "";
      const response = await listOrdersRoute(
        new Request("http://portal.test/api/orders?tab=attention&page=1&pageSize=25", {
          headers: { cookie: `${cookie}${view}`, host: "portal.test" },
        }),
      );
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.orders).toHaveLength(1);
      expect(body.orders[0].salesOrderNumber).toBe("SO2196");
      expect(body.counts.attention).toBe(1);
      expect(Object.prototype.hasOwnProperty.call(body.orders[0], "customerCost")).toBe(item.pricing);
      expect(Object.prototype.hasOwnProperty.call(body.orders[0], "pendingReviewCount")).toBe(item.review);
      expect(Object.prototype.hasOwnProperty.call(body.orders[0], "samBuildStatus")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(body.orders[0], "samUrl")).toBe(false);
      expect(JSON.stringify(body)).not.toMatch(/carrierPay|carrier_pay|staffNotes|staff_notes/);
      if (item.pricing) expect(body.orders[0].customerCost).toBe(1750);
    }
  });
});
