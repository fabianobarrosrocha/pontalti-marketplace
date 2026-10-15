-- References and fulfilment states only. The customer account lives in pontalti-core-api.
begin;

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
commit;
