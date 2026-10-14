import { randomUUID } from "node:crypto";
import type { PortalContext } from "@/lib/db";
import { withTransaction } from "@/lib/db";
import type { Site } from "@/lib/types";
import type { z } from "zod";
import type { siteSchema } from "@/lib/validate";

type SiteInput = z.infer<typeof siteSchema>;

export async function listSites(ctx: PortalContext, includeInactive = false): Promise<Site[]> {
  const sql = includeInactive
    ? `SELECT id, company, address1, city, state, postal_code, country, active, sort_order FROM sites ORDER BY sort_order, company`
    : `SELECT id, company, address1, city, state, postal_code, country, active, sort_order FROM sites WHERE active = 1 ORDER BY sort_order, company`;
  const rows = await ctx.db.prepare(sql).all();
  return rows.map(mapSite);
}

function mapSite(row: Record<string, unknown>): Site {
  return {
    id: String(row.id),
    company: String(row.company),
    address1: String(row.address1),
    city: String(row.city),
    state: String(row.state),
    postalCode: String(row.postal_code ?? ""),
    country: String(row.country ?? "US"),
    active: Number(row.active) === 1,
    sortOrder: Number(row.sort_order ?? 0),
  };
}

export async function replaceSites(ctx: PortalContext, sites: SiteInput[]): Promise<Site[]> {
  await withTransaction(ctx.db, async () => {
    await ctx.db.prepare(`DELETE FROM sites`).run();
    const insert = ctx.db.prepare(
      `INSERT INTO sites (id, company, address1, city, state, postal_code, country, active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [index, site] of sites.entries()) {
      await insert.run(
        site.id || randomUUID(),
        site.company,
        site.address1,
        site.city,
        site.state,
        site.postalCode ?? "",
        site.country || "US",
        site.active === false ? 0 : 1,
        index,
      );
    }
  });
  return await listSites(ctx, true);
}
