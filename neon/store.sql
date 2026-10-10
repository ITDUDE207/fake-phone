-- App Store tables. Run AFTER neon/schema.sql (it uses my_number()).
--
-- Flow: anyone signed in can submit an app (status 'pending'). Only admins can approve or
-- reject. Everyone sees approved apps; authors also see their own submissions.
-- To make yourself an admin, run once (your Account ID is shown in the phone's Settings):
--   insert into public.admins (user_id) values ('<your account id>');

create table public.admins (user_id text primary key);
alter table public.admins enable row level security;  -- no policies: only the SQL editor can change it

create function public.is_admin() returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from public.admins where user_id = auth.user_id()) $$;

create table public.store_apps (
  id            bigint generated always as identity primary key,
  slug          text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name          text not null check (char_length(name) between 1 and 30),
  description   text not null default '' check (char_length(description) <= 300),
  version       text not null default '' check (char_length(version) <= 20),
  permissions   text[] not null default '{}' check (cardinality(permissions) <= 8),
  author_id     text not null default (auth.user_id()),
  author_number text not null,
  bundle        text not null check (char_length(bundle) <= 1500000),
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at    timestamptz not null default now()
);
create index store_apps_status_idx on public.store_apps (status, created_at desc);
create index store_apps_author_idx on public.store_apps (author_id, created_at desc);
create index store_apps_slug_idx   on public.store_apps (slug);

-- An app id (slug) belongs to whoever submitted it first, so nobody can publish
-- a look-alike update under someone else's id. Runs with owner rights to see all rows.
create function public.slug_ok(s text) returns boolean
  language sql stable security definer set search_path = public
  as $$ select not exists (
         select 1 from public.store_apps
         where slug = s and author_id <> auth.user_id() and status in ('pending', 'approved')) $$;

-- At most 5 submissions per hour and 30 stored per person.
create function public.store_throttle() returns trigger
  language plpgsql as $$
begin
  if (select count(*) from public.store_apps where author_id = new.author_id and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Too many submissions: try again in an hour';
  end if;
  if (select count(*) from public.store_apps where author_id = new.author_id) >= 30 then
    raise exception 'You have too many apps in the store: delete some first';
  end if;
  return new;
end $$;
create trigger store_throttle before insert on public.store_apps
  for each row execute function public.store_throttle();

revoke execute on function public.is_admin(), public.slug_ok(text) from public;
grant  execute on function public.is_admin(), public.slug_ok(text) to authenticated;

alter table public.store_apps enable row level security;

create policy store_read on public.store_apps for select to authenticated
  using (status = 'approved' or author_id = auth.user_id() or public.is_admin());
create policy store_submit on public.store_apps for insert to authenticated
  with check (
    author_id = auth.user_id()
    and status = 'pending'
    and author_number = public.my_number()
    and public.slug_ok(slug)
  );
create policy store_review on public.store_apps for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy store_delete on public.store_apps for delete to authenticated
  using (author_id = auth.user_id() or public.is_admin());

grant select, insert, delete on public.store_apps to authenticated;
grant update (status) on public.store_apps to authenticated;  -- reviewers change nothing else
