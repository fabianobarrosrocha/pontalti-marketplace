import { Client } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { TEST_DATABASE_URL } from "../tests/support/config";
export { TEST_DATABASE_URL } from "../tests/support/config";

async function main() {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    const exists = await client.query("select to_regclass('public.whatsapp_outbox') as name");
    if (exists.rows[0].name) {
      console.log("Banco de testes já preparado.");
      return;
    }
    await client.query(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create role authenticator login password 'pontalti-local-test' noinherit;
      grant anon, authenticated, service_role to authenticator;
      create schema auth;
      create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claims',true)::json->>'sub','')::uuid;
      $$;
      grant usage on schema auth,public to anon,authenticated,service_role;
      grant execute on function auth.uid() to anon,authenticated,service_role;
    `);
    const directory = resolve("supabase/migrations");
    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".sql") && !file.startsWith("0003_"))
      .sort();
    for (const file of files) await client.query(await readFile(resolve(directory, file), "utf8"));
    console.log("Migrations aplicadas ao Postgres isolado de testes (Storage não é necessário).");
  } finally {
    await client.end();
  }
}
main().catch(() => {
  console.error("Falha ao preparar o banco isolado. Recrie somente o compose de testes.");
  process.exitCode = 1;
});
