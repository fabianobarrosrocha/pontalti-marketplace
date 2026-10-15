-- Cadastro pelo contato vinculado e repetição de pedidos, sem reset de dados.
begin;

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
commit;
