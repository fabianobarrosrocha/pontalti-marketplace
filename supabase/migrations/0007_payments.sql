-- 0007_payments.sql — Etapa 8 (pagamento Banco Cora)
-- Tabela de cobranças + novo ciclo de status do pedido.

create table public.order_payments (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.orders(id) on delete cascade,
  cora_invoice_id   text not null unique,
  status            text not null default 'open',
                    -- open | in_payment | paid | expired | cancelled
  amount            numeric(10,2) not null,
  pix_qr_code       text,              -- EMV copia-e-cola (null se a conta não tiver chave Pix)
  boleto_url        text,
  boleto_digitable  text,              -- linha digitável do boleto
  due_date          date,
  paid_at           timestamptz,
  raw_response      jsonb,             -- última resposta da Cora (auditoria)
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index on public.order_payments (order_id);

create trigger set_updated_at before update on public.order_payments
  for each row execute procedure public.set_updated_at();

-- RLS: dono do pedido lê o pagamento; escrita apenas via service role.
alter table public.order_payments enable row level security;

create policy "own_order_payments_select" on public.order_payments
  for select using (
    exists (select 1 from public.orders o where o.id = order_id and o.customer_id = auth.uid())
  );

-- GRANTs ("expose new tables OFF": toda tabela nova precisa disso)
grant select on public.order_payments to authenticated;

-- Pedidos novos nascem aguardando pagamento.
alter table public.orders alter column status set default 'awaiting_payment';

-- Rollback do checkout agora apaga pedidos 'awaiting_payment' (além de 'pending').
drop policy "own_pending_orders_delete" on public.orders;
create policy "own_pending_orders_delete" on public.orders
  for delete using (auth.uid() = customer_id and status in ('pending', 'awaiting_payment'));
