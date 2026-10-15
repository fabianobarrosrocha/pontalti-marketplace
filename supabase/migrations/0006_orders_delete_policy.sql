-- 0006_orders_delete_policy.sql — Etapa 7 (checkout)
-- Permite ao cliente apagar o PRÓPRIO pedido enquanto 'pending'. Usado pelo
-- rollback do checkout (se a gravação dos itens falhar, o pedido órfão é
-- removido) e, no futuro, por um "cancelar pedido" do cliente.

grant delete on public.orders to authenticated;

create policy "own_pending_orders_delete" on public.orders
  for delete using (auth.uid() = customer_id and status = 'pending');
