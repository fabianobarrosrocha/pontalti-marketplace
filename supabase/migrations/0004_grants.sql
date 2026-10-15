-- 0004_grants.sql — grants de API (complemento à Etapa 1)
-- O projeto foi criado com "expose new tables OFF", então tabelas novas não
-- ganham privilégios automáticos para os roles da API (anon/authenticated).
-- O RLS (0002) continua sendo quem filtra AS LINHAS; os grants abaixo apenas
-- liberam o acesso às tabelas no nível necessário para as policies operarem.

-- catálogo: leitura pública (RLS limita a is_visible = true)
grant select on public.product_marketplace_config to anon, authenticated;
grant select on public.product_images to anon, authenticated;

-- dados do cliente: só usuários logados (RLS limita às próprias linhas)
grant select, update on public.customers to authenticated;
grant select, insert, update, delete on public.customer_addresses to authenticated;
grant select, insert, update, delete on public.carts to authenticated;
grant select, insert, update, delete on public.cart_items to authenticated;

-- pedidos: cliente lê e cria; atualização de status é via service role
grant select, insert on public.orders to authenticated;
grant select, insert on public.order_items to authenticated;
