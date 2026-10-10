-- fake-phone messaging schema for Neon.
-- Run in the Neon SQL Editor AFTER enabling Neon Auth and the Data API
-- (the Data API provides the `auth` schema and the `authenticated` role).

create table public.profiles (
  user_id text primary key default (auth.user_id()),
  number  text not null unique check (number ~ '^[0-9]{10}$')
);

create table public.messages (
  id          bigint generated always as identity primary key,
  sender_id   text not null default (auth.user_id()),
  from_number text not null,
  to_number   text not null check (to_number ~ '^[0-9]{10}$'),
  body        text not null check (char_length(body) between 1 and 1000),
  created_at  timestamptz not null default now()
);
create index messages_to_idx   on public.messages (to_number, id);
create index messages_from_idx on public.messages (from_number, id);

-- Helpers run with owner rights so policies can look up numbers without
-- exposing the profiles table to other users.
create function public.my_number() returns text
  language sql stable security definer set search_path = public
  as $$ select number from public.profiles where user_id = auth.user_id() $$;

create function public.number_exists(n text) returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from public.profiles where number = n) $$;

revoke execute on function public.my_number(), public.number_exists(text) from public;
grant  execute on function public.my_number(), public.number_exists(text) to authenticated;

alter table public.profiles enable row level security;
alter table public.messages enable row level security;

-- You can see and create only your own profile (one number per account, never changed).
create policy profiles_read_own on public.profiles for select to authenticated
  using (user_id = auth.user_id());
create policy profiles_claim on public.profiles for insert to authenticated
  with check (user_id = auth.user_id());

-- You can read messages you sent or received, and send only as yourself, to a real number.
create policy messages_read on public.messages for select to authenticated
  using (sender_id = auth.user_id() or to_number = public.my_number());
create policy messages_send on public.messages for insert to authenticated
  with check (
    sender_id = auth.user_id()
    and from_number = public.my_number()
    and public.number_exists(to_number)
  );

grant select, insert on public.profiles, public.messages to authenticated;
