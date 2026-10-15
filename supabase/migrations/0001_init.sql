-- 0001_init.sql — Etapa 1.1 do PLANO-IMPLEMENTACAO-MARKETPLACE.md
-- Tabelas do marketplace (banco Supabase, separado do Postgres da fábrica).

-- ─────────────────────────────────────────────────────────────
-- CUSTOMERS (perfil B2C, 1:1 com auth.users)
-- ─────────────────────────────────────────────────────────────
create table public.customers (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  phone       text,
  cpf         text unique,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Trigger: cria linha em public.customers automaticamente após signup
create function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.customers (id, full_name, phone, cpf)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.raw_user_meta_data->>'phone',
    new.raw_user_meta_data->>'cpf'
  );
  return new;
end; $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ─────────────────────────────────────────────────────────────
-- ADDRESSES
-- ─────────────────────────────────────────────────────────────
create table public.customer_addresses (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,
  zip_code      text not null,
  street        text not null,
  number        text not null,
  complement    text,
  neighborhood  text not null,
  city          text not null,
  state         text not null,
  is_default    boolean default false,
  created_at    timestamptz default now()
);

create index on public.customer_addresses (customer_id);

-- ─────────────────────────────────────────────────────────────
-- PRODUCT MARKETPLACE CONFIG (produtos exibidos na loja)
-- ─────────────────────────────────────────────────────────────
create table public.product_marketplace_config (
  id                   uuid primary key default gen_random_uuid(),
  factory_product_id   integer not null unique,   -- Products.id no pontalti-core-api
  factory_sku          text not null,
  is_visible           boolean default true,
  display_title        text not null,
  display_description  text,
  display_price        numeric(10,2) not null,
  display_order        integer default 0,
  category             text,
  seo_slug             text unique,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);

create index on public.product_marketplace_config (is_visible, display_order);

-- ─────────────────────────────────────────────────────────────
-- PRODUCT IMAGES
-- ─────────────────────────────────────────────────────────────
create table public.product_images (
  id                      uuid primary key default gen_random_uuid(),
  marketplace_config_id   uuid not null references public.product_marketplace_config(id) on delete cascade,
  storage_path            text not null,           -- ex.: 'products/<uuid>.jpg'
  alt_text                text,
  is_primary              boolean default false,
  display_order           integer default 0,
  created_at              timestamptz default now()
);

create index on public.product_images (marketplace_config_id);

-- ─────────────────────────────────────────────────────────────
-- CART
-- ─────────────────────────────────────────────────────────────
create table public.carts (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid unique not null references public.customers(id) on delete cascade,
  updated_at   timestamptz default now()
);

create table public.cart_items (
  id                       uuid primary key default gen_random_uuid(),
  cart_id                  uuid not null references public.carts(id) on delete cascade,
  product_config_id        uuid not null references public.product_marketplace_config(id),
  quantity                 integer not null check (quantity > 0),
  unit_price_snapshot      numeric(10,2) not null,
  created_at               timestamptz default now(),
  unique (cart_id, product_config_id)
);

-- ─────────────────────────────────────────────────────────────
-- ORDERS (sem pagamento por enquanto)
-- ─────────────────────────────────────────────────────────────
create table public.orders (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid not null references public.customers(id),
  address_id         uuid not null references public.customer_addresses(id),
  status             text not null default 'pending',
                     -- pending | confirmed | shipped | delivered | cancelled
  subtotal           numeric(10,2) not null,
  total              numeric(10,2) not null,
  factory_order_id   integer,                       -- Orders.id no pontalti-core-api
  notes              text,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

create table public.order_items (
  order_id            uuid not null references public.orders(id) on delete cascade,
  product_config_id   uuid not null references public.product_marketplace_config(id),
  quantity            integer not null,
  unit_price          numeric(10,2) not null,
  primary key (order_id, product_config_id)
);

-- ─────────────────────────────────────────────────────────────
-- updated_at automático (customers, product_marketplace_config,
-- carts, orders) — evita updated_at estagnado esquecido pelo app
-- ─────────────────────────────────────────────────────────────
create function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

create trigger set_updated_at before update on public.customers
  for each row execute procedure public.set_updated_at();
create trigger set_updated_at before update on public.product_marketplace_config
  for each row execute procedure public.set_updated_at();
create trigger set_updated_at before update on public.carts
  for each row execute procedure public.set_updated_at();
create trigger set_updated_at before update on public.orders
  for each row execute procedure public.set_updated_at();
