-- 0003_storage.sql — Etapa 1.3 do PLANO-IMPLEMENTACAO-MARKETPLACE.md
-- Bucket público para imagens de produto. Escrita apenas via service role
-- (nenhuma policy de INSERT/UPDATE/DELETE é criada de propósito — o
-- service role ignora RLS, e o anon/authenticated ficam sem permissão).

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

-- Leitura pública via API (o acesso via URL pública do bucket já é aberto
-- por `public = true`; esta policy cobre list/download pela API).
--
-- OBS: se o SQL Editor retornar "must be owner of table objects", crie esta
-- policy pelo Dashboard: Storage → product-images → Policies → New policy
-- (SELECT, roles anon + authenticated, expressão: bucket_id = 'product-images').
create policy "public_read_product_images" on storage.objects
  for select using (bucket_id = 'product-images');
