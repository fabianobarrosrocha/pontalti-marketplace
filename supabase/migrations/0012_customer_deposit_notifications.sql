-- Notification references only; no balance or financial posting lives in Supabase.
begin;
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
commit;
