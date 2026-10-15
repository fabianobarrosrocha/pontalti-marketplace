import type { SupabaseClient } from "@supabase/supabase-js";
import type { Pool } from "pg";
import { CATALOG_SELECT, type CatalogConfigRow } from "../../src/lib/catalog-shared";
import { BOT_CATALOG_PAGE_SIZE, mapBotProduct } from "../../src/lib/whatsapp/repository";

export type SourceCatalogRow = CatalogConfigRow & {
  factory_product_id: number;
  display_order: number;
  is_visible: boolean;
};
const SELECT = CATALOG_SELECT + ",factory_product_id,display_order,is_visible";

/** Reads the public store; only its local test mirror can be written. */
export class SupabaseTestCatalog {
  constructor(
    private readonly source: SupabaseClient,
    private readonly pool: Pool,
    private readonly sourceUrl: string
  ) {}

  private async mirror(rows: SourceCatalogRow[], requestedIds: string[]) {
    const db = await this.pool.connect();
    try {
      if ((await db.query("select current_database() as name")).rows[0].name !== "pontalti_whatsapp_test")
        throw new Error("TEST_DATABASE_REQUIRED");
      await db.query("begin");
      if (requestedIds.length)
        await db.query("update public.product_marketplace_config set is_visible=false where id=any($1::uuid[])", [requestedIds]);
      for (const row of rows)
        await db.query(`insert into public.product_marketplace_config
          (id,factory_product_id,factory_sku,display_title,display_description,display_price,display_order,category,seo_slug,is_visible)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,true) on conflict(id) do update set
          factory_product_id=excluded.factory_product_id,factory_sku=excluded.factory_sku,display_title=excluded.display_title,display_description=excluded.display_description,
          display_price=excluded.display_price,display_order=excluded.display_order,category=excluded.category,
          seo_slug=excluded.seo_slug,is_visible=true`, [
          row.id, row.factory_product_id, row.factory_sku, row.display_title, row.display_description,
          row.display_price, row.display_order, row.category, row.seo_slug
        ]);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    } finally {
      db.release();
    }
  }

  async catalog(query: string, page: number) {
    let request = this.source.from("product_marketplace_config").select(SELECT)
      .eq("is_visible", true).gt("display_price", 0).order("display_order").order("id");
    if (query) request = request.ilike("display_title", "%" + query.replace(/[%_]/g, "") + "%");
    const start = Math.max(0, Math.min(1000, page)) * BOT_CATALOG_PAGE_SIZE;
    const { data, error } = await request.range(start, start + BOT_CATALOG_PAGE_SIZE);
    if (error) throw new Error("Não foi possível consultar o catálogo da loja.");
    const rows = (data ?? []) as unknown as SourceCatalogRow[];
    await this.mirror(rows, []);
    return {
      products: rows.slice(0, BOT_CATALOG_PAGE_SIZE).map((row) => mapBotProduct(row, this.sourceUrl)),
      hasMore: rows.length > BOT_CATALOG_PAGE_SIZE
    };
  }

  async products(ids: string[]) {
    if (!ids.length) return [];
    const { data, error } = await this.source.from("product_marketplace_config").select(SELECT)
      .eq("is_visible", true).gt("display_price", 0).in("id", ids);
    if (error) throw new Error("Não foi possível conferir os produtos da loja.");
    const rows = (data ?? []) as unknown as SourceCatalogRow[];
    await this.mirror(rows, ids);
    return rows.map((row) => mapBotProduct(row, this.sourceUrl));
  }
}
