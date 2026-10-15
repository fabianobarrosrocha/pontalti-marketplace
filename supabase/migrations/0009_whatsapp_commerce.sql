-- Checkout compartilhado e atendimento automático. Aditiva: não reseta dados.
begin;

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
commit;
