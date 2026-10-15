-- 0008_notification_log.sql
-- Log unificado das notificações enviadas (Telegram interno + WhatsApp cliente).
-- Escrito pelo marketplace-frontend e pelo factory-control via service role.
-- Rodar manualmente no SQL Editor do Supabase (mesmo fluxo das migrations anteriores).

create table if not exists public.notification_log (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('telegram', 'whatsapp')),
  event text not null, -- order_created | payment_confirmed | payment_expired | factory_registered | status_changed
  order_id uuid references public.orders (id) on delete set null,
  recipient text, -- número WhatsApp (55DDDNÚMERO); null para Telegram (chat interno fixo)
  status text not null check (status in ('sent', 'failed', 'skipped')),
  error text,
  created_at timestamptz not null default now()
);

create index if not exists notification_log_order_id_idx on public.notification_log (order_id);
create index if not exists notification_log_created_at_idx on public.notification_log (created_at desc);

-- Sem policies: com RLS ligado, anon/authenticated não leem nem escrevem.
-- Service role ignora RLS.
alter table public.notification_log enable row level security;

revoke all on table public.notification_log from anon, authenticated;
grant all on table public.notification_log to service_role;
