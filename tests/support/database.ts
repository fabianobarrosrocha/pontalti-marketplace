import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";

import { TEST_DATABASE_URL, TEST_API_URL } from "./config";
export { TEST_DATABASE_URL, TEST_API_URL } from "./config";
export const CUSTOMER_A = "10000000-0000-4000-8000-000000000001";
export const CUSTOMER_B = "10000000-0000-4000-8000-000000000002";
export const ADDRESS_A = "20000000-0000-4000-8000-000000000001";
export const ADDRESS_B = "20000000-0000-4000-8000-000000000002";
export const PRODUCT_A = "30000000-0000-4000-8000-000000000001";
export const PRODUCT_HIDDEN = "30000000-0000-4000-8000-000000000002";
const SECRET = "pontalti-whatsapp-local-test-secret-with-32-characters";

export function localToken(role = "service_role", sub?: string, lifetimeSeconds = 3600) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ role, sub, exp: Math.floor(Date.now() / 1000) + lifetimeSeconds })).toString(
    "base64url"
  );
  const input = header + "." + body;
  return input + "." + createHmac("sha256", SECRET).update(input).digest("base64url");
}
export function localDatabase(role = "service_role", sub?: string, lifetimeSeconds = 3600) {
  const token = localToken(role, sub, lifetimeSeconds);
  return createClient(TEST_API_URL, token, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: "Bearer " + token } }
  });
}
export async function seedTestDatabase() {
  // Esta URL é fixa e aponta exclusivamente ao compose de testes.
  const pg = new Client({ connectionString: TEST_DATABASE_URL });
  await pg.connect();
  try {
    const info = await pg.query("select current_database() as name");
    if (info.rows[0].name !== "pontalti_whatsapp_test") throw new Error("TEST_DATABASE_REQUIRED");
    await pg.query(
      "truncate auth.users,public.product_marketplace_config,public.commerce_notification_events restart identity cascade"
    );
    await pg.query("insert into auth.users(id,email,raw_user_meta_data) values($1,null,$2),($3,null,$4)", [
      CUSTOMER_A,
      { full_name: "Cliente de teste A", cpf: "52998224725" },
      CUSTOMER_B,
      { full_name: "Cliente de teste B", cpf: "11144477735" }
    ]);
    await pg.query(
      "insert into public.customer_addresses(id,customer_id,zip_code,street,number,neighborhood,city,state) values($1,$2,'01001000','Rua de teste','1','Teste','São Paulo','SP'),($3,$4,'01001000','Outra rua','2','Teste','São Paulo','SP')",
      [ADDRESS_A, CUSTOMER_A, ADDRESS_B, CUSTOMER_B]
    );
    await pg.query(
      "insert into public.product_marketplace_config(id,factory_product_id,factory_sku,display_title,display_price,is_visible) values($1,991,'TEST-A','Bojo de teste',10,true),($2,992,'TEST-H','Produto oculto',5,false)",
      [PRODUCT_A, PRODUCT_HIDDEN]
    );
    await pg.query("update public.whatsapp_settings set value=$1 where key='delivery'", [
      { enabled: true, description: "Retirada de teste", feeCents: 0, states: ["SP"] }
    ]);
    await pg.query("update public.whatsapp_settings set value='\"unidade de teste\"'::jsonb where key='unit_label'");
  } finally {
    await pg.end();
  }
}
