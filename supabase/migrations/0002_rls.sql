-- 0002_rls.sql — Etapa 1.2 do PLANO-IMPLEMENTACAO-MARKETPLACE.md
-- Row Level Security. Escrita administrativa (catálogo, status de pedido)
-- acontece via service role no factory-control, que ignora RLS.

alter table public.customers enable row level security;
alter table public.customer_addresses enable row level security;
alter table public.carts enable row level security;
alter table public.cart_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.product_marketplace_config enable row level security;
alter table public.product_images enable row level security;

-- customers: dono lê e edita o próprio perfil
create policy "own_profile_select" on public.customers for select using (auth.uid() = id);
create policy "own_profile_update" on public.customers for update using (auth.uid() = id);

-- addresses: dono lê, insere, edita, apaga
create policy "own_addresses_all" on public.customer_addresses
  for all using (auth.uid() = customer_id) with check (auth.uid() = customer_id);

-- carts e items: idem
create policy "own_cart_all" on public.carts
  for all using (auth.uid() = customer_id) with check (auth.uid() = customer_id);

create policy "own_cart_items_all" on public.cart_items
  for all using (
    exists (select 1 from public.carts c where c.id = cart_id and c.customer_id = auth.uid())
  ) with check (
    exists (select 1 from public.carts c where c.id = cart_id and c.customer_id = auth.uid())
  );

-- orders: dono lê tudo, mas só insere (admin atualiza status via service role)
create policy "own_orders_select" on public.orders for select using (auth.uid() = customer_id);
create policy "own_orders_insert" on public.orders for insert with check (auth.uid() = customer_id);

create policy "own_order_items_select" on public.order_items for select using (
  exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid())
);
create policy "own_order_items_insert" on public.order_items for insert with check (
  exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid())
);

-- catálogo: leitura pública só de visíveis; escrita via service role
create policy "public_visible_products" on public.product_marketplace_config
  for select using (is_visible = true);

create policy "public_product_images" on public.product_images
  for select using (
    exists (select 1 from public.product_marketplace_config p
            where p.id = marketplace_config_id and p.is_visible = true)
  );
