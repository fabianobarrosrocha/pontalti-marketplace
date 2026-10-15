-- Pontalti: ativação de saldo, aprovação de compras e depósitos no Supabase.
-- Execute este arquivo completo no SQL Editor do projeto da loja.
-- Aplica apenas as etapas ausentes; preserva clientes, pedidos e pagamentos.
-- Uma transação: qualquer erro desfaz todas as alterações desta execução.
BEGIN;
DO $pontalti_setup$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pontalti-customer-account-schema'));
  IF to_regclass('public.order_payments') IS NULL OR to_regclass('public.customers') IS NULL THEN
    RAISE EXCEPTION 'A base da loja (migrações 0001 a 0007) precisa estar instalada antes deste arquivo.';
  END IF;

  -- 0008_notification_log.sql
  IF to_regclass('public.notification_log') IS NULL THEN
    EXECUTE $pontalti_sql_0008$
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

$pontalti_sql_0008$;
  END IF;

  -- 0009_whatsapp_commerce.sql
  IF to_regclass('public.checkout_intents') IS NULL THEN
    EXECUTE $pontalti_sql_0009$
-- Checkout compartilhado e atendimento automático. Aditiva: não reseta dados.

alter table public.carts add column version bigint not null default 0;
alter table public.orders add column origin text not null default 'website'
  check (origin in ('website', 'whatsapp'));
alter table public.orders add column delivery_description text;
alter table public.orders add column shipping_amount numeric(10,2) not null default 0;
alter table public.order_payments add column last_checked_at timestamptz;
alter table public.order_payments add column last_check_attempt_at timestamptz;

create table public.whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider = 'evolution'),
  account text not null,
  wa_id text not null check (wa_id ~ '^[0-9]{10,15}$'),
  customer_id uuid references public.customers(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(provider, account, wa_id)
);
create table public.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null unique references public.whatsapp_contacts(id) on delete cascade,
  state jsonb not null default '{}',
  version bigint not null default 0,
  last_received_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz
);
alter table public.orders add column whatsapp_conversation_id uuid
  references public.whatsapp_conversations(id);

create table public.whatsapp_inbox_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  external_id text not null,
  text text not null,
  received_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','processing','done','failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  error text,
  unique(conversation_id, external_id)
);
create table public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  external_id text,
  content jsonb not null,
  delivery_status text,
  created_at timestamptz not null default now()
);
create table public.whatsapp_outbox (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity unique,
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  dedupe_key text not null unique,
  content jsonb not null,
  status text not null default 'pending'
    check (status in ('pending','sending','accepted','unknown','failed','cancelled')),
  provider_message_id text,
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create table public.whatsapp_account_links (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.whatsapp_contacts(id) on delete cascade,
  token_hash text not null unique,
  customer_id uuid references public.customers(id) on delete cascade,
  challenge_hash text,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  confirmed_event_id uuid unique,
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.whatsapp_settings (
  key text primary key,
  value jsonb not null
);
insert into public.whatsapp_settings values
  ('delivery', '{"enabled":false,"description":"","feeCents":0,"states":[]}'),
  ('unit_label', '""');
create table public.support_articles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  answer text not null,
  enabled boolean not null default false,
  display_order integer not null default 0
);
insert into public.support_articles(title, answer, enabled) values
  ('Como pagar?', 'Depois de confirmar o pedido, você recebe Pix ou boleto gerados pela Cora. Pague pelo seu banco. A confirmação é consultada na Cora; enviar um comprovante não altera o pedido para pago.', true),
  ('Como acompanhar?', 'Acesse Meus pedidos nesta conversa após vincular sua conta. Você também pode consultar o mesmo pedido na conta da loja.', true);

create table public.commerce_cart_mutations (
  customer_id uuid not null references public.customers(id) on delete cascade,
  operation_id text not null,
  result jsonb not null,
  primary key(customer_id, operation_id)
);
create table public.checkout_intents (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id),
  customer_id uuid not null references public.customers(id),
  cart_id uuid not null references public.carts(id),
  cart_version bigint not null,
  idempotency_key uuid not null unique default gen_random_uuid(),
  invoice_input jsonb not null,
  status text not null default 'pending' check(status in ('pending','issuing','ready','review')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  first_attempt_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique(cart_id, cart_version)
);
create table public.commerce_notification_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  event text not null check(event in ('order_created','payment_confirmed','payment_expired')),
  status text not null default 'pending' check(status in ('pending','processing','done')),
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz not null default now(),
  unique(order_id,event)
);
create index on public.whatsapp_inbox_events(status, available_at, received_at);
create index on public.whatsapp_outbox(status, available_at, created_at);
create index on public.checkout_intents(status,next_attempt_at);

-- Também detecta edições feitas fora dos serviços (ex.: administração).
create function public.commerce_bump_cart_version() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  update public.carts set version = version + 1
  where id = coalesce(new.cart_id, old.cart_id);
  return null;
end $$;
create trigger bump_cart_version after insert or update or delete on public.cart_items
  for each row execute function public.commerce_bump_cart_version();

create function public.commerce_mutate_cart(
  p_customer_id uuid, p_lines jsonb, p_mode text, p_operation_id text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.carts; r jsonb; line jsonb; product public.product_marketplace_config;
  qty integer; current_qty integer;
begin
  if p_mode not in ('set','increment','clear') or length(p_operation_id) > 200
    or p_operation_id is null then raise exception 'INVALID_CART'; end if;
  insert into public.carts(customer_id) values(p_customer_id)
    on conflict(customer_id) do nothing;
  select * into c from public.carts where customer_id=p_customer_id for update;
  select result into r from public.commerce_cart_mutations
    where customer_id=p_customer_id and operation_id=p_operation_id;
  if found then return r; end if;
  if p_mode='clear' then
    delete from public.cart_items where cart_id=c.id;
  else
    if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines)>100 then
      raise exception 'INVALID_CART'; end if;
    for line in select value from jsonb_array_elements(p_lines) loop
      qty := (line->>'quantity')::integer;
      select quantity into current_qty from public.cart_items
        where cart_id=c.id and product_config_id=(line->>'productId')::uuid;
      if p_mode='increment' then qty := coalesce(current_qty,0) + qty; end if;
      qty := least(999, greatest(0, qty));
      if qty=0 then
        delete from public.cart_items where cart_id=c.id
          and product_config_id=(line->>'productId')::uuid;
      else
        select * into product from public.product_marketplace_config
          where id=(line->>'productId')::uuid and is_visible=true and display_price>0;
        if not found then raise exception 'PRODUCT_UNAVAILABLE'; end if;
        insert into public.cart_items(cart_id,product_config_id,quantity,unit_price_snapshot)
          values(c.id,product.id,qty,product.display_price)
          on conflict(cart_id,product_config_id) do update
            set quantity=excluded.quantity,unit_price_snapshot=excluded.unit_price_snapshot;
      end if;
    end loop;
  end if;
  select jsonb_build_object('version',version,'items',coalesce((select jsonb_agg(
    jsonb_build_object('productId',product_config_id,'quantity',quantity))
    from public.cart_items where cart_id=c.id),'[]'::jsonb)) into r
    from public.carts where id=c.id;
  insert into public.commerce_cart_mutations values(p_customer_id,p_operation_id,r);
  return r;
end $$;

create function public.commerce_my_cart(p_lines jsonb, p_mode text, p_operation_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'UNAUTHORIZED'; end if;
  return public.commerce_mutate_cart(auth.uid(),p_lines,p_mode,p_operation_id);
end $$;

create function public.commerce_prepare_checkout(
  p_customer_id uuid, p_address_id uuid, p_cart_version bigint,
  p_expected_subtotal_cents bigint, p_origin text, p_conversation_id uuid,
  p_expected_fee_cents bigint default 0, p_expected_delivery text default 'Envio a combinar',
  p_notes text default null
) returns public.checkout_intents language plpgsql security definer
set search_path = public, pg_temp as $$
declare c public.carts; intent public.checkout_intents; cust public.customers;
  address public.customer_addresses; delivery jsonb; fee bigint:=0;
  description text := 'Envio a combinar'; subtotal bigint; oid uuid; due text;
begin
  select * into c from public.carts where customer_id=p_customer_id for update;
  if not found then raise exception 'EMPTY_CART'; end if;
  select * into intent from public.checkout_intents where cart_id=c.id and cart_version=p_cart_version;
  if found then return intent; end if;
  if c.version <> p_cart_version then raise exception 'CART_CHANGED'; end if;
  if p_origin not in ('website','whatsapp') then raise exception 'INVALID_ORIGIN'; end if;
  select * into cust from public.customers where id=p_customer_id;
  if cust.cpf is null or cust.full_name='' then raise exception 'PROFILE_INCOMPLETE'; end if;
  select * into address from public.customer_addresses where id=p_address_id and customer_id=p_customer_id;
  if not found then raise exception 'ADDRESS_UNAVAILABLE'; end if;
  if p_origin='whatsapp' then
    if not exists(select 1 from public.whatsapp_conversations cv join public.whatsapp_contacts ct
      on ct.id=cv.contact_id where cv.id=p_conversation_id and ct.customer_id=p_customer_id)
      then raise exception 'UNAUTHORIZED'; end if;
    select value into delivery from public.whatsapp_settings where key='delivery';
    if not coalesce((delivery->>'enabled')::boolean,false) or coalesce(delivery->>'description','')=''
      or not exists(select 1 from public.whatsapp_settings where key='unit_label' and value #>> '{}' <> '')
      then raise exception 'DELIVERY_NOT_CONFIGURED'; end if;
    if jsonb_array_length(delivery->'states')>0 and not (delivery->'states' ? address.state)
      then raise exception 'ADDRESS_NOT_SERVED'; end if;
    fee := (delivery->>'feeCents')::bigint;
    if fee < 0 then raise exception 'INVALID_DELIVERY'; end if;
    description := delivery->>'description';
    if fee <> p_expected_fee_cents or description is distinct from p_expected_delivery
      then raise exception 'DELIVERY_CHANGED'; end if;
  end if;
  -- Preço e visibilidade não mudam entre o cálculo e a gravação dos itens.
  perform p.id from public.product_marketplace_config p join public.cart_items i on i.product_config_id=p.id
    where i.cart_id=c.id order by p.id for share of p;
  if exists(select 1 from public.cart_items i join public.product_marketplace_config p on p.id=i.product_config_id
    where i.cart_id=c.id and (not coalesce(p.is_visible,false) or p.display_price<=0))
    then raise exception 'PRODUCT_UNAVAILABLE'; end if;
  select sum(round(p.display_price*100)::bigint * i.quantity) into subtotal
    from public.cart_items i join public.product_marketplace_config p on p.id=i.product_config_id
    where i.cart_id=c.id;
  if subtotal is null then raise exception 'EMPTY_CART'; end if;
  if subtotal <> p_expected_subtotal_cents then raise exception 'PRICE_CHANGED'; end if;
  if subtotal+fee < 500 then raise exception 'MINIMUM_ORDER'; end if;
  due := to_char((now() at time zone 'America/Sao_Paulo')::date + 3,'YYYY-MM-DD');
  insert into public.orders(customer_id,address_id,status,subtotal,total,notes,origin,
    whatsapp_conversation_id,shipping_amount,delivery_description)
    values(p_customer_id,p_address_id,'awaiting_payment',subtotal/100.0,(subtotal+fee)/100.0,
      left(p_notes,1000),p_origin,p_conversation_id,fee/100.0,description) returning id into oid;
  insert into public.order_items(order_id,product_config_id,quantity,unit_price)
    select oid,i.product_config_id,i.quantity,p.display_price
      from public.cart_items i join public.product_marketplace_config p on p.id=i.product_config_id where i.cart_id=c.id;
  insert into public.checkout_intents(order_id,customer_id,cart_id,cart_version,invoice_input)
    values(oid,p_customer_id,c.id,c.version,jsonb_build_object(
      'code',oid,'customerName',left(cust.full_name,60),
      'customerEmail',(select email from auth.users where id=p_customer_id),
      'cpf',regexp_replace(cust.cpf,'\D','','g'),'amountCents',subtotal+fee,
      'description','Pedido Pontalti #' || left(oid::text,8),'dueDate',due)) returning * into intent;
  -- Reserva os itens junto do pedido. Adições posteriores ficam no carrinho.
  delete from public.cart_items where cart_id=c.id;
  return intent;
end $$;

create function public.commerce_claim_checkout(p_intent_id uuid, p_token uuid)
returns public.checkout_intents language plpgsql security definer set search_path = public, pg_temp as $$
declare intent public.checkout_intents;
begin
  update public.checkout_intents set status='issuing',lease_token=p_token,
    lease_until=now()+interval '2 minutes',attempts=attempts+1,
    first_attempt_at=coalesce(first_attempt_at,now())
    where id=p_intent_id and status in ('pending','issuing') and next_attempt_at<=now()
    and (lease_until is null or lease_until<now())
    returning * into intent;
  return intent;
end $$;

create function public.commerce_finish_checkout(p_intent_id uuid,p_token uuid,p_invoice jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare intent public.checkout_intents; invoice_id text:=p_invoice->>'id';
begin
  select * into intent from public.checkout_intents where id=p_intent_id for update;
  if intent.status='ready' then return intent.order_id; end if;
  if intent.lease_token is distinct from p_token or intent.lease_until<now() then raise exception 'LEASE_LOST'; end if;
  if invoice_id is null or invoice_id not like 'inv_%' or p_invoice->>'total_amount' is null
    or (p_invoice->>'total_amount')::bigint <> (intent.invoice_input->>'amountCents')::bigint
    or p_invoice->>'code' is distinct from intent.order_id::text then raise exception 'INVALID_INVOICE'; end if;
  insert into public.order_payments(order_id,cora_invoice_id,status,amount,pix_qr_code,
    boleto_url,boleto_digitable,due_date,raw_response)
    values(intent.order_id,invoice_id,'open',(intent.invoice_input->>'amountCents')::numeric/100,
      p_invoice#>>'{pix,emv}',p_invoice#>>'{payment_options,bank_slip,url}',
      p_invoice#>>'{payment_options,bank_slip,digitable}',(intent.invoice_input->>'dueDate')::date,p_invoice);
  update public.checkout_intents set status='ready',lease_token=null,lease_until=null,error=null where id=intent.id;
  insert into public.commerce_notification_events(order_id,event) values(intent.order_id,'order_created') on conflict do nothing;
  return intent.order_id;
end $$;

create function public.commerce_apply_payment(p_invoice_id text,p_status text,p_invoice jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare pay public.order_payments; ord public.orders; target text;
begin
  select * into pay from public.order_payments where cora_invoice_id=p_invoice_id for update;
  if not found then return null; end if;
  if p_invoice->>'id' is distinct from p_invoice_id or p_invoice->>'total_amount' is null
    or (p_invoice->>'total_amount')::numeric <> round(pay.amount*100)
    then raise exception 'INVALID_INVOICE'; end if;
  select * into ord from public.orders where id=pay.order_id for update;
  if p_status='paid' and (p_invoice->>'total_paid' is null or (p_invoice->>'total_paid')::numeric < round(pay.amount*100))
    then raise exception 'INVALID_INVOICE'; end if;
  -- Uma consulta atrasada nunca regride uma confirmação já persistida.
  if pay.status='paid' then p_status:='paid'; end if;
  if p_status not in ('open','in_payment','paid','cancelled') then p_status:=pay.status; end if;
  update public.order_payments set status=p_status,
    raw_response=case when pay.status='paid' and p_invoice->>'status'<>'PAID' then raw_response else p_invoice end,
    last_checked_at=now(),last_check_attempt_at=now(),
    pix_qr_code=coalesce(p_invoice#>>'{pix,emv}',pix_qr_code),
    boleto_url=coalesce(p_invoice#>>'{payment_options,bank_slip,url}',boleto_url),
    boleto_digitable=coalesce(p_invoice#>>'{payment_options,bank_slip,digitable}',boleto_digitable),
    paid_at=case when p_status='paid' then coalesce(paid_at,now()) else paid_at end where id=pay.id;
  target := case p_status when 'paid' then 'paid' when 'cancelled' then 'payment_expired' else null end;
  if target is not null and ord.status='awaiting_payment' then
    update public.orders set status=target where id=ord.id;
    ord.status:=target;
    insert into public.commerce_notification_events(order_id,event)
      values(ord.id,case target when 'paid' then 'payment_confirmed' else 'payment_expired' end) on conflict do nothing;
  end if;
  return jsonb_build_object('paymentStatus',p_status,'orderStatus',ord.status);
end $$;

create function public.whatsapp_receive(p_account text,p_wa_id text,p_external_id text,p_text text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare contact uuid; conversation uuid; event_id uuid;
begin
  insert into public.whatsapp_contacts(provider,account,wa_id) values('evolution',p_account,p_wa_id)
    on conflict(provider,account,wa_id) do update set wa_id=excluded.wa_id returning id into contact;
  insert into public.whatsapp_conversations(contact_id) values(contact)
    on conflict(contact_id) do update set last_received_at=now() returning id into conversation;
  insert into public.whatsapp_inbox_events(conversation_id,external_id,text)
    values(conversation,p_external_id,left(p_text,2000)) on conflict do nothing returning id into event_id;
  if event_id is not null then
    insert into public.whatsapp_messages(conversation_id,direction,external_id,content)
      values(conversation,'in',p_external_id,jsonb_build_object('type','text','text',left(p_text,2000)));
  end if;
  return event_id;
end $$;

create function public.whatsapp_claim_event(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.whatsapp_inbox_events; cv public.whatsapp_conversations; ct public.whatsapp_contacts;
begin
  -- Bloqueia a conversa antes do evento: dois workers não avançam a mesma sessão.
  select c.* into cv from public.whatsapp_conversations c
    where (c.lease_until is null or c.lease_until<now()) and exists(
      select 1 from public.whatsapp_inbox_events i where i.conversation_id=c.id
      and i.status in ('pending','processing') and i.available_at<=now()
      and (i.lease_until is null or i.lease_until<now()))
    order by c.last_received_at for update skip locked limit 1;
  if not found then return null; end if;
  select * into e from public.whatsapp_inbox_events where conversation_id=cv.id
    and status in ('pending','processing') order by received_at,id for update limit 1;
  if e.available_at>now() or e.lease_until>now() then return null; end if;
  update public.whatsapp_conversations set lease_token=p_token,lease_until=now()+interval '5 minutes' where id=cv.id;
  update public.whatsapp_inbox_events set status='processing',attempts=attempts+1,
    lease_token=p_token,lease_until=now()+interval '5 minutes' where id=e.id;
  select * into ct from public.whatsapp_contacts where id=cv.contact_id;
  return jsonb_build_object('event',to_jsonb(e),'conversation',to_jsonb(cv),'contact',to_jsonb(ct));
end $$;

create function public.whatsapp_complete_event(p_event_id uuid,p_token uuid,p_state jsonb,p_replies jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.whatsapp_inbox_events; msg jsonb; n integer:=0;
begin
  select * into e from public.whatsapp_inbox_events where id=p_event_id for update;
  if e.status='done' then return; end if;
  if e.lease_token is distinct from p_token or e.lease_until<now() then raise exception 'LEASE_LOST'; end if;
  update public.whatsapp_conversations set state=p_state,version=version+1,
    lease_token=null,lease_until=null where id=e.conversation_id and lease_token=p_token;
  if not found then raise exception 'LEASE_LOST'; end if;
  for msg in select value from jsonb_array_elements(p_replies) loop
    insert into public.whatsapp_outbox(conversation_id,dedupe_key,content)
      values(e.conversation_id,e.id::text || ':' || n,msg) on conflict do nothing;
    n:=n+1;
  end loop;
  update public.whatsapp_inbox_events set status='done',lease_token=null,lease_until=null,error=null where id=e.id;
end $$;

create function public.whatsapp_retry_event(p_event_id uuid,p_token uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare cv uuid;
begin
  update public.whatsapp_inbox_events set status=case when attempts>=8 then 'failed' else 'pending' end,
    available_at=now()+interval '30 seconds',lease_token=null,lease_until=null,error='PROCESSING_FAILED'
    where id=p_event_id and lease_token=p_token returning conversation_id into cv;
  update public.whatsapp_conversations set lease_token=null,lease_until=null where id=cv and lease_token=p_token;
end $$;

create function public.whatsapp_claim_outbox(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare msg public.whatsapp_outbox; ct public.whatsapp_contacts;
begin
  -- Uma queda depois de enviar pode ter chegado ao telefone: não reenviar cegamente.
  update public.whatsapp_outbox set status='unknown',error='SEND_RESULT_UNKNOWN',lease_token=null,lease_until=null
    where status='sending' and lease_until<now();
  select o.* into msg from public.whatsapp_outbox o where o.status='pending' and o.available_at<=now()
    and not exists(select 1 from public.whatsapp_outbox before_msg
      where before_msg.conversation_id=o.conversation_id and before_msg.status in ('pending','sending')
      and before_msg.sequence<o.sequence)
    order by o.sequence for update skip locked limit 1;
  if not found then return null; end if;
  update public.whatsapp_outbox set status='sending',lease_token=p_token,lease_until=now()+interval '1 minute',attempts=attempts+1
    where id=msg.id;
  select ct1.* into ct from public.whatsapp_contacts ct1 join public.whatsapp_conversations cv
    on cv.contact_id=ct1.id where cv.id=msg.conversation_id;
  return jsonb_build_object('message',to_jsonb(msg),'contact',to_jsonb(ct));
end $$;

create function public.whatsapp_claim_link(p_token_hash text,p_customer_id uuid,p_challenge_hash text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare link public.whatsapp_account_links;
begin
  select * into link from public.whatsapp_account_links where token_hash=p_token_hash for update;
  if not found or link.expires_at<now() or link.confirmed_at is not null or link.attempts>=5
    or (link.customer_id is not null and link.customer_id<>p_customer_id) then raise exception 'LINK_INVALID'; end if;
  if exists(select 1 from public.whatsapp_contacts where id=link.contact_id and customer_id is not null)
    then raise exception 'ALREADY_LINKED'; end if;
  update public.whatsapp_account_links set customer_id=p_customer_id,challenge_hash=p_challenge_hash where id=link.id;
  return link.id;
end $$;

create function public.whatsapp_finish_outbox(p_id uuid,p_token uuid,p_status text,p_external_id text,p_error text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare msg public.whatsapp_outbox;
begin
  select * into msg from public.whatsapp_outbox where id=p_id for update;
  if msg.status<>'sending' or msg.lease_token is distinct from p_token then raise exception 'LEASE_LOST'; end if;
  if p_status not in ('accepted','unknown','failed','pending','cancelled') then raise exception 'INVALID_STATUS'; end if;
  if p_status='pending' and msg.attempts>=8 then p_status:='failed'; end if;
  update public.whatsapp_outbox set status=p_status,provider_message_id=p_external_id,error=p_error,
    lease_token=null,lease_until=null,available_at=now()+interval '30 seconds' where id=p_id;
  if p_status='accepted' then
    insert into public.whatsapp_messages(conversation_id,direction,external_id,content,delivery_status)
      values(msg.conversation_id,'out',p_external_id,msg.content,'accepted');
  end if;
  if p_status<>'pending' then
    insert into public.notification_log(channel,event,status,error)
      values('whatsapp','bot_message',case p_status when 'accepted' then 'sent' when 'cancelled' then 'skipped' else 'failed' end,p_error);
  end if;
end $$;

create function public.commerce_claim_notification(p_token uuid,p_account text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare event public.commerce_notification_events; ord public.orders; cv public.whatsapp_conversations;
  ct public.whatsapp_contacts; message text; queued boolean:=false;
begin
  select * into event from public.commerce_notification_events where status in ('pending','processing')
    and available_at<=now() and (lease_until is null or lease_until<now())
    order by available_at,id for update skip locked limit 1;
  if not found then return null; end if;
  update public.commerce_notification_events set status='processing',lease_token=p_token,lease_until=now()+interval '2 minutes' where id=event.id;
  select * into ord from public.orders where id=event.order_id;
  select c.* into cv from public.whatsapp_conversations c join public.whatsapp_contacts contact on contact.id=c.contact_id
    where contact.customer_id=ord.customer_id and contact.account=p_account
    and (ord.origin='website' or c.id=ord.whatsapp_conversation_id) order by c.last_received_at desc limit 1;
  if found then
    select * into ct from public.whatsapp_contacts where id=cv.contact_id;
    if event.event<>'order_created' or cv.state->>'orderId' is distinct from ord.id::text then
      message := case event.event
        when 'order_created' then 'O pagamento do pedido #' || left(ord.id::text,8) || ' está disponível. Escreva pedidos para consultar Pix ou boleto.'
        when 'payment_confirmed' then 'Pagamento confirmado pela Cora! Pedido #' || left(ord.id::text,8) || '. Escreva pedidos para acompanhar.'
        else 'A cobrança do pedido #' || left(ord.id::text,8) || ' foi cancelada. Consulte seu pedido antes de tentar pagar.' end;
      insert into public.whatsapp_outbox(conversation_id,dedupe_key,content)
        values(cv.id,'notification:' || event.id,jsonb_build_object('type','text','text',message,'customerId',ord.customer_id)) on conflict do nothing;
    end if;
    queued:=true;
  end if;
  return jsonb_build_object('id',event.id,'orderId',ord.id,'event',event.event,
    'skipWhatsApp',queued or ord.origin='whatsapp');
end $$;

create function public.whatsapp_confirm_link(p_contact_id uuid,p_challenge_hash text,p_event_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare link public.whatsapp_account_links;
begin
  perform 1 from public.whatsapp_contacts where id=p_contact_id for update;
  select * into link from public.whatsapp_account_links where contact_id=p_contact_id and confirmed_event_id=p_event_id;
  if found then return (select customer_id from public.whatsapp_contacts where id=p_contact_id); end if;
  select * into link from public.whatsapp_account_links where contact_id=p_contact_id and confirmed_at is null
    and expires_at>now() and customer_id is not null order by created_at desc for update limit 1;
  if not found or link.attempts>=5 then return null; end if;
  update public.whatsapp_account_links set attempts=attempts+1 where id=link.id;
  if link.challenge_hash is distinct from p_challenge_hash then return null; end if;
  update public.whatsapp_contacts set customer_id=link.customer_id where id=p_contact_id and customer_id is null;
  if not found then return null; end if;
  update public.whatsapp_account_links set confirmed_at=now(),confirmed_event_id=p_event_id where id=link.id;
  update public.whatsapp_account_links set expires_at=now() where contact_id=p_contact_id and id<>link.id and confirmed_at is null;
  return link.customer_id;
end $$;

create function public.whatsapp_unlink(p_contact_id uuid,p_customer_id uuid default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform 1 from public.whatsapp_contacts where id=p_contact_id
    and (p_customer_id is null or customer_id=p_customer_id) for update;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  update public.whatsapp_contacts set customer_id=null where id=p_contact_id;
  update public.whatsapp_account_links set expires_at=now() where contact_id=p_contact_id;
  update public.whatsapp_conversations set state='{}',version=version+1 where contact_id=p_contact_id;
end $$;

-- Dados do canal e funções privilegiadas só são acessíveis no servidor.
do $$ declare name text; fn record;
begin
  foreach name in array array['whatsapp_contacts','whatsapp_conversations','whatsapp_inbox_events',
    'whatsapp_messages','whatsapp_outbox','whatsapp_account_links','whatsapp_settings','support_articles',
    'commerce_cart_mutations','checkout_intents','commerce_notification_events'] loop
    execute format('alter table public.%I enable row level security',name);
    execute format('revoke all on public.%I from anon, authenticated',name);
    execute format('grant all on public.%I to service_role',name);
  end loop;
  for fn in select oid::regprocedure as signature from pg_proc
    where pronamespace='public'::regnamespace and (proname like 'commerce_%' or proname like 'whatsapp_%') loop
    execute format('revoke execute on function %s from public, anon, authenticated',fn.signature);
    execute format('grant execute on function %s to service_role',fn.signature);
  end loop;
end $$;
grant execute on function public.commerce_my_cart(jsonb,text,text) to authenticated;
-- Obriga os clientes autenticados a alterar o carrinho por RPC atômica.
revoke insert, update, delete on public.cart_items from authenticated;
revoke insert, delete on public.orders from authenticated;
revoke insert on public.order_items from authenticated;
notify pgrst, 'reload schema';

$pontalti_sql_0009$;
  END IF;

  -- 0010_whatsapp_account_repeat.sql
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='customer_addresses' AND column_name='archived_at') THEN
    EXECUTE $pontalti_sql_0010$
-- Cadastro pelo contato vinculado e repetição de pedidos, sem reset de dados.

-- Preserva o destino de pedidos anteriores quando um endereço é corrigido no bot.
alter table public.customer_addresses add column archived_at timestamptz;
create function public.commerce_check_active_address() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.customer_addresses
    where id=new.address_id and customer_id=new.customer_id and archived_at is null for share;
  if not found then raise exception 'ADDRESS_UNAVAILABLE'; end if;
  return new;
end $$;
create trigger check_active_order_address before insert or update of address_id on public.orders
  for each row execute function public.commerce_check_active_address();

create table public.whatsapp_customer_mutations (
  customer_id uuid not null references public.customers(id) on delete cascade,
  operation_id text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (customer_id, operation_id)
);
alter table public.whatsapp_customer_mutations enable row level security;
revoke all on public.whatsapp_customer_mutations from anon, authenticated;
grant all on public.whatsapp_customer_mutations to service_role;

create function public.whatsapp_update_customer(
  p_customer_id uuid, p_contact_id uuid, p_operation_id text,
  p_kind text, p_data jsonb, p_address_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare result jsonb; address_id uuid; region text; previous public.customer_addresses;
begin
  perform 1 from public.whatsapp_contacts where id=p_contact_id and customer_id=p_customer_id for update;
  if not found then raise exception 'ACCOUNT_UNLINKED'; end if;
  perform 1 from public.customers where id=p_customer_id for update;
  if p_operation_id is null or length(p_operation_id) not between 1 and 200
    or jsonb_typeof(p_data) is distinct from 'object' then raise exception 'INVALID_CUSTOMER_DATA'; end if;
  select m.result into result from public.whatsapp_customer_mutations m
    where m.customer_id=p_customer_id and m.operation_id=p_operation_id;
  if found then return result; end if;
  if p_kind='profile' then
    if not (p_data ? 'fullName' or p_data ? 'phone')
      or (p_data ? 'fullName' and (jsonb_typeof(p_data->'fullName') is distinct from 'string'
        or length(trim(p_data->>'fullName')) not between 3 and 120))
      or (p_data ? 'phone' and p_data->'phone'<>'null'::jsonb
        and coalesce(p_data->>'phone','') !~ '^[0-9]{10,11}$') then
      raise exception 'INVALID_CUSTOMER_DATA';
    end if;
    update public.customers set
      full_name=case when p_data ? 'fullName' then trim(p_data->>'fullName') else full_name end,
      phone=case when p_data ? 'phone' then p_data->>'phone' else phone end
      where id=p_customer_id;
    result:=jsonb_build_object('saved',true);
  elsif p_kind='address' then
    region:=upper(p_data->>'state');
    if coalesce(p_data->>'zipCode','') !~ '^[0-9]{8}$'
      or not coalesce(region=any(array['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']),false)
      or exists(select 1 from unnest(array['street','number','neighborhood','city']) field
        where jsonb_typeof(p_data->field) is distinct from 'string'
          or length(trim(coalesce(p_data->>field,''))) not between 1 and 200)
      or length(coalesce(p_data->>'complement',''))>200
      or (p_data ? 'isDefault' and jsonb_typeof(p_data->'isDefault') is distinct from 'boolean') then
      raise exception 'INVALID_CUSTOMER_DATA';
    end if;
    if p_address_id is not null then
      select * into previous from public.customer_addresses
        where id=p_address_id and customer_id=p_customer_id and archived_at is null for update;
      if not found then raise exception 'ADDRESS_UNAVAILABLE'; end if;
      if exists(select 1 from public.orders o where o.address_id=p_address_id)
        and row(previous.zip_code,previous.street,previous.number,coalesce(previous.complement,''),previous.neighborhood,previous.city,previous.state)
          is distinct from row(p_data->>'zipCode',trim(p_data->>'street'),trim(p_data->>'number'),coalesce(trim(p_data->>'complement'),''),
            trim(p_data->>'neighborhood'),trim(p_data->>'city'),region) then
        update public.customer_addresses set archived_at=now(),is_default=false where id=p_address_id;
        p_address_id:=null;
      end if;
    end if;
    if coalesce((p_data->>'isDefault')::boolean,false) then
      update public.customer_addresses set is_default=false where customer_id=p_customer_id and is_default=true;
    end if;
    if p_address_id is null then
      insert into public.customer_addresses(customer_id,zip_code,street,number,complement,neighborhood,city,state,is_default)
      values(p_customer_id,p_data->>'zipCode',trim(p_data->>'street'),trim(p_data->>'number'),nullif(trim(p_data->>'complement'),''),
        trim(p_data->>'neighborhood'),trim(p_data->>'city'),region,coalesce((p_data->>'isDefault')::boolean,false))
        returning id into address_id;
    else
      update public.customer_addresses set zip_code=p_data->>'zipCode',street=trim(p_data->>'street'),
        number=trim(p_data->>'number'),complement=nullif(trim(p_data->>'complement'),''),
        neighborhood=trim(p_data->>'neighborhood'),city=trim(p_data->>'city'),state=region,
        is_default=coalesce((p_data->>'isDefault')::boolean,false)
        where id=p_address_id and customer_id=p_customer_id returning id into address_id;
    end if;
    result:=jsonb_build_object('addressId',address_id);
  else
    raise exception 'INVALID_CUSTOMER_DATA';
  end if;
  insert into public.whatsapp_customer_mutations(customer_id,operation_id,result) values(p_customer_id,p_operation_id,result);
  return result;
end $$;

create function public.whatsapp_repeat_order(
  p_customer_id uuid, p_contact_id uuid, p_order_id uuid, p_lines jsonb, p_operation_id text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare cart public.carts; line jsonb; product public.product_marketplace_config;
  result jsonb; qty integer; existing_qty integer;
begin
  perform 1 from public.whatsapp_contacts where id=p_contact_id and customer_id=p_customer_id for update;
  if not found then raise exception 'ACCOUNT_UNLINKED'; end if;
  perform 1 from public.orders where id=p_order_id and customer_id=p_customer_id for share;
  if not found then raise exception 'ORDER_UNAVAILABLE'; end if;
  if p_operation_id is null or length(p_operation_id) not between 1 and 200
    or jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'ORDER_UNAVAILABLE'; end if;
  insert into public.carts(customer_id) values(p_customer_id) on conflict(customer_id) do nothing;
  select * into cart from public.carts where customer_id=p_customer_id for update;
  select m.result into result from public.commerce_cart_mutations m
    where m.customer_id=p_customer_id and m.operation_id=p_operation_id;
  if found then return result; end if;
  if jsonb_array_length(p_lines) not between 1 and 100
    or jsonb_array_length(p_lines)<>(select count(*) from public.order_items where order_id=p_order_id)
    or (select count(distinct value->>'productId') from jsonb_array_elements(p_lines))<>jsonb_array_length(p_lines) then
    raise exception 'ORDER_UNAVAILABLE';
  end if;
  for line in select value from jsonb_array_elements(p_lines) order by value->>'productId' loop
    select quantity into qty from public.order_items
      where order_id=p_order_id and product_config_id=(line->>'productId')::uuid for share;
    if not found or qty is distinct from (line->>'quantity')::integer then raise exception 'ORDER_UNAVAILABLE'; end if;
    select * into product from public.product_marketplace_config where id=(line->>'productId')::uuid for share;
    if not found or not product.is_visible or product.display_price<=0 then raise exception 'PRODUCT_UNAVAILABLE'; end if;
    if (product.display_price*100)::bigint is distinct from (line->>'priceCents')::bigint then raise exception 'PRICE_CHANGED'; end if;
    select quantity into existing_qty from public.cart_items where cart_id=cart.id and product_config_id=product.id;
    if qty not between 1 and 999 or coalesce(existing_qty,0)+qty>999 then raise exception 'QUANTITY_LIMIT'; end if;
  end loop;
  return public.commerce_mutate_cart(p_customer_id,p_lines,'increment',p_operation_id);
end $$;

revoke execute on function public.whatsapp_update_customer(uuid,uuid,text,text,jsonb,uuid) from public,anon,authenticated;
revoke execute on function public.whatsapp_repeat_order(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.whatsapp_update_customer(uuid,uuid,text,text,jsonb,uuid) to service_role;
grant execute on function public.whatsapp_repeat_order(uuid,uuid,uuid,jsonb,text) to service_role;
notify pgrst, 'reload schema';

$pontalti_sql_0010$;
  END IF;

  -- 0011_customer_account_balance.sql
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='payment_method') THEN
    EXECUTE $pontalti_sql_0011$
-- References and fulfilment states only. The customer account lives in pontalti-core-api.

alter table public.orders add column payment_method text not null default 'cora'
  check(payment_method in ('cora','account_balance'));
alter table public.orders add column balance_purchase_id uuid unique;
alter table public.orders add column balance_debt_cents bigint not null default 0 check(balance_debt_cents>=0);
alter table public.orders add column balance_environment text check(balance_environment in ('STAGE','PRODUCTION'));
alter table public.checkout_intents add column payment_method text not null default 'cora'
  check(payment_method in ('cora','account_balance'));
alter table public.checkout_intents add column finance_environment text check(finance_environment in ('STAGE','PRODUCTION'));
alter table public.checkout_intents add column core_purchase_id uuid unique;
alter table public.checkout_intents add column core_purchase_version integer not null default 0;
alter table public.checkout_intents add column finance_consent jsonb;
alter table public.checkout_intents add column finance_order_snapshot jsonb;
alter table public.checkout_intents add column core_purchase_status text
  check(core_purchase_status in ('PENDING','APPROVED','REJECTED','CANCELLED'));
alter table public.checkout_intents drop constraint checkout_intents_status_check;
alter table public.checkout_intents add constraint checkout_intents_status_check
  check(status in ('pending','issuing','ready','review','balance_pending','balance_ready','balance_review'));
alter table public.commerce_notification_events drop constraint commerce_notification_events_event_check;
alter table public.commerce_notification_events add constraint commerce_notification_events_event_check
  check(event in ('order_created','payment_confirmed','payment_expired','balance_pending','balance_approved','balance_rejected','balance_cancelled'));

-- Preserve the original cart/address/price locking and immutable order snapshot.
alter function public.commerce_prepare_checkout(uuid,uuid,bigint,bigint,text,uuid,bigint,text,text)
  rename to commerce_prepare_cora_checkout;
create function public.commerce_prepare_checkout(
  p_customer_id uuid,p_address_id uuid,p_cart_version bigint,p_expected_subtotal_cents bigint,
  p_origin text,p_conversation_id uuid,p_expected_fee_cents bigint default 0,
  p_expected_delivery text default 'Envio a combinar',p_notes text default null,
  p_payment_method text default 'cora',p_finance_environment text default null,p_balance_consent jsonb default null
) returns public.checkout_intents language plpgsql security definer set search_path=public,pg_temp as $$
declare intent public.checkout_intents; existing_id uuid;
begin
  if p_payment_method not in ('cora','account_balance') or
    (p_payment_method='account_balance' and (p_finance_environment is null or p_finance_environment not in ('STAGE','PRODUCTION')))
    then raise exception 'INVALID_PAYMENT_METHOD'; end if;
  if p_payment_method='account_balance' and (p_balance_consent is null or
    jsonb_typeof(p_balance_consent->'account_revision') is distinct from 'number' or
    jsonb_typeof(p_balance_consent->'projected_balance_cents') is distinct from 'number')
    then raise exception 'INVALID_BALANCE_CONSENT'; end if;
  -- Same row lock as the original function; a replay cannot change payment methods.
  perform 1 from public.carts where customer_id=p_customer_id for update;
  select i.id into existing_id from public.checkout_intents i join public.carts c on c.id=i.cart_id
    where c.customer_id=p_customer_id and i.cart_version=p_cart_version;
  if found then
    select * into intent from public.checkout_intents where id=existing_id;
    if intent.payment_method<>p_payment_method or
      (p_payment_method='account_balance' and intent.finance_environment is distinct from p_finance_environment)
      then raise exception 'PAYMENT_METHOD_CHANGED'; end if;
    return intent;
  end if;
  intent:=public.commerce_prepare_cora_checkout(p_customer_id,p_address_id,p_cart_version,
    p_expected_subtotal_cents,p_origin,p_conversation_id,p_expected_fee_cents,p_expected_delivery,p_notes);
  if p_payment_method='account_balance' then
    update public.checkout_intents set payment_method=p_payment_method,finance_environment=p_finance_environment,
      finance_consent=p_balance_consent,
      finance_order_snapshot=(select jsonb_build_object('items', (select jsonb_agg(jsonb_build_object(
        'name',p.display_title,'product_id',p.factory_product_id,'quantity',i.quantity,
        'unit_price_cents',round(i.unit_price*100)::bigint) order by i.product_config_id)
        from public.order_items i join public.product_marketplace_config p on p.id=i.product_config_id
        where i.order_id=o.id),'shipping_cents',round(o.shipping_amount*100)::bigint,
        'discount_cents',0,'delivery',o.delivery_description,'notes',o.notes,
        'address',(select jsonb_build_object('zip_code',a.zip_code,'neighborhood',a.neighborhood,
          'public_place',a.street,'city',a.city,'state',a.state,'address_number',a.number,
          'complement',a.complement) from public.customer_addresses a where a.id=o.address_id))
        from public.orders o where o.id=intent.order_id),
      status='balance_pending' where id=intent.id returning * into intent;
    update public.orders set payment_method=p_payment_method,balance_environment=p_finance_environment,
      status='awaiting_balance_approval' where id=intent.order_id;
  end if;
  return intent;
end $$;

-- A balance intent can never be claimed by the Cora invoice issuer.
create or replace function public.commerce_claim_checkout(p_intent_id uuid,p_token uuid)
returns public.checkout_intents language plpgsql security definer set search_path=public,pg_temp as $$
declare intent public.checkout_intents;
begin
  update public.checkout_intents set status='issuing',lease_token=p_token,
    lease_until=now()+interval '2 minutes',attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now())
    where id=p_intent_id and payment_method='cora' and status in ('pending','issuing')
    and next_attempt_at<=now() and (lease_until is null or lease_until<now()) returning * into intent;
  return intent;
end $$;

create function public.commerce_apply_balance_purchase(p_intent_id uuid,p_purchase jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare intent public.checkout_intents; ord public.orders; target text; decision text:=p_purchase->>'status';
begin
  select * into intent from public.checkout_intents where id=p_intent_id for update;
  if not found or intent.payment_method<>'account_balance' then raise exception 'INVALID_BALANCE_INTENT'; end if;
  select * into ord from public.orders where id=intent.order_id for update;
  if p_purchase->>'id' is null or p_purchase->>'external_order_id' is distinct from ord.id::text
    or p_purchase->>'external_customer_id' is distinct from ord.customer_id::text
    or p_purchase->>'environment' is distinct from intent.finance_environment
    or p_purchase->>'amount_cents' is null
    or (p_purchase->>'amount_cents')::bigint<>round(ord.total*100)::bigint
    or decision is null or decision not in ('PENDING','APPROVED','REJECTED','CANCELLED')
    or p_purchase->>'version' is null or (p_purchase->>'version')::integer<1
    or (intent.core_purchase_id is not null and intent.core_purchase_id::text is distinct from p_purchase->>'id')
    then raise exception 'INVALID_BALANCE_PURCHASE'; end if;
  -- Later authenticated cancellation releases/refunds in the core; stale polls never regress.
  if (p_purchase->>'version')::integer<=intent.core_purchase_version then return ord.id; end if;
  if intent.core_purchase_status in ('REJECTED','CANCELLED') or
    (intent.core_purchase_status='APPROVED' and decision not in ('APPROVED','CANCELLED')) then return ord.id; end if;
  target:=case decision when 'PENDING' then 'awaiting_balance_approval' when 'APPROVED' then 'balance_approved'
    when 'REJECTED' then 'balance_rejected' else 'balance_cancelled' end;
  update public.checkout_intents set core_purchase_id=(p_purchase->>'id')::uuid,core_purchase_status=decision,
    core_purchase_version=(p_purchase->>'version')::integer,
    status=case decision when 'PENDING' then 'balance_pending' else 'balance_ready' end,
    next_attempt_at=now()+interval '30 seconds',error=null where id=intent.id;
  if ord.status='awaiting_balance_approval' or (decision='CANCELLED' and ord.status='balance_approved') then
    update public.orders set status=target where id=ord.id;
  end if;
  update public.orders set balance_purchase_id=(p_purchase->>'id')::uuid,
    balance_debt_cents=case when decision='APPROVED' then greatest(0,
      (p_purchase->>'amount_cents')::bigint-coalesce((p_purchase->>'cash_applied_cents')::bigint,0)) else 0 end,
    factory_order_id=coalesce((p_purchase->>'core_order_id')::integer,factory_order_id) where id=ord.id;
  insert into public.commerce_notification_events(order_id,event) values(ord.id,
    case decision when 'PENDING' then 'balance_pending' when 'APPROVED' then 'balance_approved'
      when 'REJECTED' then 'balance_rejected' else 'balance_cancelled' end) on conflict do nothing;
  return ord.id;
end $$;

revoke execute on function public.commerce_prepare_checkout(uuid,uuid,bigint,bigint,text,uuid,bigint,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.commerce_prepare_checkout(uuid,uuid,bigint,bigint,text,uuid,bigint,text,text,text,text,jsonb) to service_role;
revoke execute on function public.commerce_apply_balance_purchase(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.commerce_apply_balance_purchase(uuid,jsonb) to service_role;

create or replace function public.commerce_claim_notification(p_token uuid,p_account text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare event public.commerce_notification_events; ord public.orders; cv public.whatsapp_conversations;
  ct public.whatsapp_contacts; message text; queued boolean:=false;
begin
  select * into event from public.commerce_notification_events where status in ('pending','processing')
    and available_at<=now() and (lease_until is null or lease_until<now())
    order by available_at,id for update skip locked limit 1;
  if not found then return null; end if;
  update public.commerce_notification_events set status='processing',lease_token=p_token,lease_until=now()+interval '2 minutes' where id=event.id;
  select * into ord from public.orders where id=event.order_id;
  select c.* into cv from public.whatsapp_conversations c join public.whatsapp_contacts contact on contact.id=c.contact_id
    where contact.customer_id=ord.customer_id and contact.account=p_account
    and (ord.origin='website' or c.id=ord.whatsapp_conversation_id) order by c.last_received_at desc limit 1;
  if found then
    select * into ct from public.whatsapp_contacts where id=cv.contact_id;
    if event.event<>'order_created' or cv.state->>'orderId' is distinct from ord.id::text then
      message := case event.event
        when 'order_created' then 'O pagamento do pedido #' || left(ord.id::text,8) || ' está disponível. Escreva pedidos para consultar Pix ou boleto.'
        when 'balance_pending' then 'O pedido #' || left(ord.id::text,8) || ' aguarda aprovação da Pontalti para usar saldo na conta. O pedido não seguirá para produção ou envio antes da aprovação.'
        when 'balance_approved' then 'A Pontalti aprovou o uso de saldo no pedido #' || left(ord.id::text,8) || '. Dívida deste pedido: R$ ' || replace(to_char(ord.balance_debt_cents/100.0,'FM999999990.00'),'.',',') || '. Escreva pedidos para acompanhar.'
        when 'balance_rejected' then 'A Pontalti não aprovou o uso de saldo no pedido #' || left(ord.id::text,8) || '. Nenhuma dívida foi efetivada por este pedido. Consulte a equipe para escolher outra forma de pagamento.'
        when 'balance_cancelled' then 'A solicitação de saldo do pedido #' || left(ord.id::text,8) || ' foi cancelada. As reservas foram liberadas.'
        when 'payment_confirmed' then 'Pagamento confirmado pela Cora! Pedido #' || left(ord.id::text,8) || '. Escreva pedidos para acompanhar.'
        else 'A cobrança do pedido #' || left(ord.id::text,8) || ' foi cancelada. Consulte seu pedido antes de tentar pagar.' end;
      insert into public.whatsapp_outbox(conversation_id,dedupe_key,content)
        values(cv.id,'notification:' || event.id,jsonb_build_object('type','text','text',message,'customerId',ord.customer_id)) on conflict do nothing;
    end if;
    queued:=true;
  end if;
  return jsonb_build_object('id',event.id,'orderId',ord.id,'event',event.event,
    'skipWhatsApp',queued or ord.origin='whatsapp');
end $$;


notify pgrst,'reload schema';

$pontalti_sql_0011$;
  END IF;

  -- 0012_customer_deposit_notifications.sql
  IF to_regclass('public.commerce_customer_deposit_refs') IS NULL THEN
    EXECUTE $pontalti_sql_0012$
-- Notification references only; no balance or financial posting lives in Supabase.

create table public.commerce_customer_deposit_refs (
  deposit_id uuid primary key,
  customer_id uuid not null references public.customers(id),
  environment text not null check(environment in ('STAGE','PRODUCTION')),
  amount_cents bigint not null check(amount_cents>0),
  status text not null check(status in ('PENDING','OPEN','UNKNOWN','CREDITED','REJECTED')),
  notified_at timestamptz,
  next_check_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.commerce_customer_deposit_refs enable row level security;
revoke all on public.commerce_customer_deposit_refs from anon,authenticated;
grant all on public.commerce_customer_deposit_refs to service_role;
create index on public.commerce_customer_deposit_refs(next_check_at);

create function public.commerce_remember_customer_deposit(p_customer_id uuid,p_deposit jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare ref public.commerce_customer_deposit_refs; v_deposit_id uuid:=(p_deposit->>'id')::uuid;
begin
  if p_deposit->>'external_customer_id' is distinct from p_customer_id::text or
    p_deposit->>'environment' is null or p_deposit->>'environment' not in ('STAGE','PRODUCTION') or
    p_deposit->>'amount_cents' is null or (p_deposit->>'amount_cents')::bigint<=0 or
    p_deposit->>'status' is null or p_deposit->>'status' not in ('PENDING','OPEN','UNKNOWN','CREDITED','REJECTED')
    then raise exception 'INVALID_DEPOSIT_REFERENCE'; end if;
  insert into public.commerce_customer_deposit_refs(deposit_id,customer_id,environment,amount_cents,status)
    values(v_deposit_id,p_customer_id,p_deposit->>'environment',(p_deposit->>'amount_cents')::bigint,p_deposit->>'status')
    on conflict do nothing;
  select * into ref from public.commerce_customer_deposit_refs d where d.deposit_id=v_deposit_id for update;
  if ref.customer_id<>p_customer_id or ref.environment is distinct from p_deposit->>'environment' or
    ref.amount_cents<>(p_deposit->>'amount_cents')::bigint then raise exception 'DEPOSIT_REFERENCE_CHANGED'; end if;
  if ref.status<>'CREDITED' then
    update public.commerce_customer_deposit_refs d set status=p_deposit->>'status' where d.deposit_id=v_deposit_id;
  end if;
  return v_deposit_id;
end $$;

create function public.commerce_notify_customer_deposit(p_customer_id uuid,p_deposit jsonb,p_account text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_deposit_id uuid; ref public.commerce_customer_deposit_refs; conversation uuid;
begin
  v_deposit_id:=public.commerce_remember_customer_deposit(p_customer_id,p_deposit);
  select * into ref from public.commerce_customer_deposit_refs d where d.deposit_id=v_deposit_id for update;
  update public.commerce_customer_deposit_refs d set next_check_at=now()+interval '60 seconds' where d.deposit_id=v_deposit_id;
  if ref.status<>'CREDITED' or ref.notified_at is not null then return; end if;
  select cv.id into conversation from public.whatsapp_conversations cv join public.whatsapp_contacts ct on ct.id=cv.contact_id
    where ct.customer_id=p_customer_id and ct.account=p_account order by cv.last_received_at desc limit 1;
  if not found then return; end if;
  insert into public.whatsapp_outbox(conversation_id,dedupe_key,content) values(conversation,
    'customer-deposit:' || v_deposit_id::text || ':CREDITED',jsonb_build_object('type','text','customerId',p_customer_id,
      'text','Recebimento confirmado no banco: R$ ' || replace(to_char(ref.amount_cents/100.0,'FM999999990.00'),'.',',') ||
      '. O valor foi lançado na sua conta Pontalti e abate eventuais dívidas. Escreva saldo para consultar o valor disponível.' ||
      case when ref.environment='STAGE' then ' Ambiente de teste: nenhuma movimentação real.' else '' end)) on conflict do nothing;
  update public.commerce_customer_deposit_refs d set notified_at=now() where d.deposit_id=v_deposit_id;
end $$;

revoke execute on function public.commerce_remember_customer_deposit(uuid,jsonb) from public,anon,authenticated;
revoke execute on function public.commerce_notify_customer_deposit(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.commerce_remember_customer_deposit(uuid,jsonb) to service_role;
grant execute on function public.commerce_notify_customer_deposit(uuid,jsonb,text) to service_role;
notify pgrst,'reload schema';

$pontalti_sql_0012$;
  END IF;
END;
$pontalti_setup$;
NOTIFY pgrst, 'reload schema';
COMMIT;
SELECT 'Saldo, aprovações e depósitos configurados com sucesso.' AS resultado;
