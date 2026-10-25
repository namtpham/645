-- ═══════════════════════════════════════════════════════════════════════════
--  645 — Supabase schema
--
--  Paste this whole file into Supabase → SQL Editor → Run.
--  It is safe to run again later (for upgrades); existing data is kept.
--
--  Security model
--    • Nobody can create an account without a single-use invitation key
--      (enforced by the trigger on auth.users, not by the web page).
--    • Every table is protected by Row Level Security. A user whose access
--      was revoked by the admin is locked out immediately, even if their
--      browser still holds a valid login token.
--    • Members can read everything, add/edit investors and weeks, and upload
--      ticket images. Only the admin can delete anything or change settings.
--    • Ticket upload time is stamped by the database, so nobody can fake it.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- ─── Tables ─────────────────────────────────────────────────────────────────

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null check (length(display_name) between 1 and 40),
  role         text not null default 'member' check (role in ('admin', 'member')),
  status       text not null default 'active' check (status in ('active', 'revoked')),
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);

create table if not exists public.invites (
  code       text primary key check (code ~ '^[2-9A-HJ-NP-Z]{12}$'),
  role       text not null default 'member' check (role in ('admin', 'member')),
  note       text not null default '' check (length(note) <= 80),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  revoked    boolean not null default false,
  used_by    uuid references public.profiles (id) on delete set null,
  used_at    timestamptz
);

create table if not exists public.settings (
  id                int primary key default 1 check (id = 1),
  title             text not null default '645' check (length(title) between 1 and 40),
  currency          text not null default 'KRW' check (currency ~ '^[A-Z]{3}$'),
  currency_display  text not null default 'symbol'
                    check (currency_display in ('symbol', 'narrowSymbol', 'code', 'name')),
  big_win_threshold numeric not null default 100000 check (big_win_threshold >= 0),
  updated_at        timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

create or replace function public.valid_amounts(j jsonb)
returns boolean language sql immutable as $$
  select jsonb_typeof(j) = 'object'
     and coalesce((select bool_and(jsonb_typeof(value) = 'number' and value::text::numeric >= 0)
                   from jsonb_each(j)), true)
$$;

create table if not exists public.investors (
  id         text primary key default substr(md5(gen_random_uuid()::text), 1, 8)
             check (id ~ '^[A-Za-z0-9_-]{1,40}$'),
  nickname   text not null check (length(trim(nickname)) between 1 and 40),
  active     boolean not null default true,     -- legacy; start/end dates decide who takes part
  since      date not null default '2025-05-17',  -- start date: first draw this investor joins
  end_date   date not null default '9999-12-31',  -- last draw this investor takes part in
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  constraint investors_dates_check check (end_date >= since)
);

-- Upgrade from the first version (no end date). Runs once.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'investors' and column_name = 'end_date') then
    alter table public.investors add column end_date date not null default '9999-12-31';
    -- Start dates could not be set before, so they were just the day the investor was added.
    update public.investors set since = '2025-05-17' where since = (created_at at time zone 'UTC')::date;
    -- Deactivated investors end at their last week with money in it.
    update public.investors i
       set end_date = greatest(i.since, coalesce((select max(w.result_date) from public.weeks w
                                                  where w.investments ? i.id), i.since))
     where not i.active;
    alter table public.investors add constraint investors_dates_check check (end_date >= since);
  end if;
end $$;
alter table public.investors alter column since set default '2025-05-17';

create table if not exists public.weeks (
  id          text primary key default substr(md5(gen_random_uuid()::text), 1, 8)
              check (id ~ '^[A-Za-z0-9_-]{1,40}$'),
  result_date date not null,
  investments jsonb not null default '{}' check (public.valid_amounts(investments)),
  pool_used   numeric not null default 0 check (pool_used >= 0),
  prize_won   numeric not null default 0 check (prize_won >= 0),
  big_win     boolean not null default false,
  notes       text not null default '' check (length(notes) <= 2000),
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id) on delete set null
);
create index if not exists weeks_result_date_idx on public.weeks (result_date);

create table if not exists public.tickets (
  id           uuid primary key default gen_random_uuid(),
  draw_date    date not null,
  storage_path text not null unique,
  thumb_path   text,
  note         text not null default '' check (length(note) <= 500),
  game_count   int check (game_count between 0 and 1000),
  width        int,
  height       int,
  bytes        int,
  qr_data      jsonb,   -- QR codes read from the photo, each with its result (see check-tickets function)
  result       jsonb,   -- reserved
  uploaded_by  uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists tickets_draw_date_idx on public.tickets (draw_date);

-- Winning numbers per draw, filled in by the check-tickets Edge Function.
create table if not exists public.draws (
  round      int primary key,
  draw_date  date,
  numbers    int[] not null check (array_length(numbers, 1) = 6),
  bonus      int not null,
  fetched_at timestamptz not null default now()
);

create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      uuid,
  table_name text not null,
  row_id     text,
  action     text not null,
  old_data   jsonb,
  new_data   jsonb
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);

-- ─── Helpers ────────────────────────────────────────────────────────────────

create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and status = 'active')
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and status = 'active' and role = 'admin')
$$;

-- Accepts "abcd-efgh-jkmn", "ABCD EFGH JKMN", … and returns "ABCDEFGHJKMN".
create or replace function public.normalize_invite(p_code text)
returns text language sql immutable as $$
  select regexp_replace(upper(coalesce(p_code, '')), '[^A-Z0-9]', '', 'g')
$$;

-- 12 characters from a 31-letter alphabet without look-alikes (0/O, 1/I/L): ~59 bits.
create or replace function public.gen_invite_code()
returns text language plpgsql volatile set search_path = public, extensions as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  b bytea := gen_random_bytes(12);
  c text := '';
begin
  for i in 0..11 loop
    c := c || substr(alphabet, (get_byte(b, i) % 31) + 1, 1);
  end loop;
  return c;
end $$;

create or replace function public.format_invite(p_code text)
returns text language sql immutable as $$
  select substr(p_code, 1, 4) || '-' || substr(p_code, 5, 4) || '-' || substr(p_code, 9, 4)
$$;

-- ─── Sign-up: only with a valid invitation key ──────────────────────────────

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_code     text := normalize_invite(new.raw_user_meta_data ->> 'invite_code');
  v_username text := lower(split_part(new.email, '@', 1));
  v_display  text := nullif(trim(new.raw_user_meta_data ->> 'display_name'), '');
  v_inv      invites;
begin
  select * into v_inv from invites where code = v_code for update;
  if not found or v_inv.used_at is not null or v_inv.revoked or v_inv.expires_at < now() then
    raise exception 'A valid, unused invitation key is required to create an account';
  end if;

  insert into profiles (id, username, display_name, role)
  values (new.id, v_username, left(coalesce(v_display, v_username), 40), v_inv.role);

  update invites set used_by = new.id, used_at = now() where code = v_code;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Public (anonymous) checks used by the "Join" form for friendly error messages.
create or replace function public.check_invite(p_code text)
returns text language sql stable security definer set search_path = public as $$
  select case
           when i.code is null        then 'invalid'
           when i.used_at is not null then 'used'
           when i.revoked             then 'revoked'
           when i.expires_at < now()  then 'expired'
           else 'ok'
         end
  from (select 1) _ left join invites i on i.code = normalize_invite(p_code)
$$;

create or replace function public.username_available(p_code text, p_username text)
returns boolean language sql stable security definer set search_path = public as $$
  select case when check_invite(p_code) <> 'ok' then null
              else not exists (select 1 from profiles where username = lower(p_username))
         end
$$;

-- Keep-alive endpoint for the GitHub Action (free Supabase projects pause when idle).
create or replace function public.ping()
returns text language sql stable as $$ select 'ok'::text $$;

-- ─── Admin RPCs ─────────────────────────────────────────────────────────────

create or replace function public.create_invite(p_note text default '', p_days int default 7,
                                                p_role text default 'member')
returns public.invites language plpgsql security definer set search_path = public as $$
declare v invites;
begin
  if not is_admin() then raise exception 'Admin only'; end if;
  insert into invites (code, role, note, created_by, expires_at)
  values (gen_invite_code(), p_role, left(coalesce(p_note, ''), 80), auth.uid(),
          now() + make_interval(days => greatest(1, least(coalesce(p_days, 7), 60))))
  returning * into v;
  return v;
end $$;

create or replace function public.admin_update_member(p_user uuid, p_status text default null,
                                                      p_role text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admin only'; end if;
  if p_user = auth.uid() then raise exception 'You cannot change your own access'; end if;
  update profiles
     set status     = coalesce(p_status, status),
         role       = coalesce(p_role, role),
         revoked_at = case when p_status = 'revoked' then now()
                           when p_status = 'active'  then null
                           else revoked_at end
   where id = p_user;
end $$;

-- Members have no e-mail address, so the admin resets forgotten passwords.
create or replace function public.admin_set_password(p_user uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_admin() then raise exception 'Admin only'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Password must be at least 8 characters'; end if;
  update auth.users
     set encrypted_password = crypt(p_password, gen_salt('bf', 10)), updated_at = now()
   where id = p_user;
end $$;

-- A photo filed under the wrong week can be moved — but only to the draw its own QR codes name.
create or replace function public.move_ticket_to_qr_draw(p_ticket uuid)
returns date language plpgsql security definer set search_path = public as $$
declare
  v_rounds int[];
  v_date date;
begin
  if not is_member() then raise exception 'Members only'; end if;
  select array_agg(distinct (q ->> 'round')::int) into v_rounds
    from tickets t, jsonb_array_elements(coalesce(t.qr_data, '[]'::jsonb)) q
   where t.id = p_ticket and q ->> 'round' ~ '^\d+$';
  if v_rounds is null or array_length(v_rounds, 1) <> 1 then
    raise exception 'The QR codes on this photo do not name exactly one draw';
  end if;
  v_date := date '2002-12-07' + (v_rounds[1] - 1) * 7;
  update tickets set draw_date = v_date where id = p_ticket;
  return v_date;
end $$;

-- ─── Stamping triggers (values the client must not choose) ──────────────────

create or replace function public.stamp_row()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  if tg_table_name = 'weeks' then
    new.updated_at := now();
    new.updated_by := auth.uid();
  end if;
  return new;
end $$;

drop trigger if exists stamp_investors on public.investors;
create trigger stamp_investors before insert or update on public.investors
  for each row execute function public.stamp_row();
drop trigger if exists stamp_weeks on public.weeks;
create trigger stamp_weeks before insert or update on public.weeks
  for each row execute function public.stamp_row();

create or replace function public.stamp_ticket()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at  := now();
    new.uploaded_by := coalesce(auth.uid(), new.uploaded_by);
  else
    new.created_at   := old.created_at;
    new.uploaded_by  := old.uploaded_by;
    new.storage_path := old.storage_path;
    new.thumb_path   := old.thumb_path;
  end if;
  return new;
end $$;

drop trigger if exists stamp_tickets on public.tickets;
create trigger stamp_tickets before insert or update on public.tickets
  for each row execute function public.stamp_ticket();

create or replace function public.touch_settings()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists touch_settings on public.settings;
create trigger touch_settings before update on public.settings
  for each row execute function public.touch_settings();

-- ─── Audit log (who changed what, readable by every member) ─────────────────

create or replace function public.audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (actor, table_name, row_id, action, old_data, new_data)
  values (auth.uid(), tg_table_name,
          coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id'),
          tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['investors', 'weeks', 'tickets', 'settings', 'profiles'] loop
    execute format('drop trigger if exists audit_%1$s on public.%1$I', t);
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$I
                    for each row execute function public.audit()', t);
  end loop;
end $$;

-- ─── Row Level Security ─────────────────────────────────────────────────────

alter table public.profiles  enable row level security;
alter table public.invites   enable row level security;
alter table public.settings  enable row level security;
alter table public.investors enable row level security;
alter table public.weeks     enable row level security;
alter table public.tickets   enable row level security;
alter table public.audit_log enable row level security;
alter table public.draws     enable row level security;

do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('profiles', 'invites', 'settings', 'investors', 'weeks', 'tickets', 'audit_log', 'draws')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- Revoked users may still read their own profile (so the app can say why).
create policy "read profiles"   on public.profiles for select to authenticated
  using (public.is_member() or id = auth.uid());
create policy "edit own name"   on public.profiles for update to authenticated
  using (id = auth.uid() and public.is_member()) with check (id = auth.uid());

create policy "admin invites"   on public.invites  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "read settings"   on public.settings for select to authenticated using (public.is_member());
create policy "admin settings"  on public.settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "read investors"  on public.investors for select to authenticated using (public.is_member());
create policy "add investors"   on public.investors for insert to authenticated with check (public.is_member());
create policy "edit investors"  on public.investors for update to authenticated
  using (public.is_member()) with check (public.is_member());
create policy "admin delete investors" on public.investors for delete to authenticated using (public.is_admin());

create policy "read weeks"      on public.weeks for select to authenticated using (public.is_member());
create policy "add weeks"       on public.weeks for insert to authenticated with check (public.is_member());
create policy "edit weeks"      on public.weeks for update to authenticated
  using (public.is_member()) with check (public.is_member());
create policy "admin delete weeks" on public.weeks for delete to authenticated using (public.is_admin());

-- Members can upload ticket photos but never delete or replace them.
create policy "read tickets"    on public.tickets for select to authenticated using (public.is_member());
create policy "upload tickets"  on public.tickets for insert to authenticated
  with check (public.is_member() and uploaded_by = auth.uid());
-- Members may correct the QR results of a photo (only qr_data/result, see grants); the
-- photo itself, its draw and its upload time stay fixed. Every correction is in the audit log.
create policy "correct ticket results" on public.tickets for update to authenticated
  using (public.is_member()) with check (public.is_member());
create policy "admin delete tickets" on public.tickets for delete to authenticated using (public.is_admin());

create policy "read audit log"  on public.audit_log for select to authenticated using (public.is_member());
create policy "read draws"      on public.draws     for select to authenticated using (public.is_member());

-- ─── Grants ─────────────────────────────────────────────────────────────────

revoke all on all tables in schema public from anon, authenticated;
grant select, insert, update, delete on public.investors, public.weeks to authenticated;
grant select, insert, delete         on public.tickets   to authenticated;
grant update (qr_data, result)       on public.tickets   to authenticated;
grant select, update                 on public.settings  to authenticated;
grant select, update, delete         on public.invites   to authenticated;
grant select                         on public.profiles, public.audit_log, public.draws to authenticated;
grant update (display_name)          on public.profiles  to authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.is_member(), public.is_admin(), public.normalize_invite(text),
                          public.format_invite(text), public.valid_amounts(jsonb),
                          public.create_invite(text, int, text),
                          public.admin_update_member(uuid, text, text),
                          public.admin_set_password(uuid, text)
  to authenticated;
grant execute on function public.move_ticket_to_qr_draw(uuid) to authenticated;
grant execute on function public.check_invite(text), public.username_available(text, text),
                          public.ping()
  to anon, authenticated;

-- ─── Storage: private bucket for ticket photos ──────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tickets', 'tickets', false, 15728640,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "645 read tickets"   on storage.objects;
drop policy if exists "645 upload tickets" on storage.objects;
drop policy if exists "645 delete tickets" on storage.objects;

create policy "645 read tickets" on storage.objects for select to authenticated
  using (bucket_id = 'tickets' and public.is_member());
-- No update policy: an uploaded file can never be overwritten.
create policy "645 upload tickets" on storage.objects for insert to authenticated
  with check (bucket_id = 'tickets' and public.is_member());
create policy "645 delete tickets" on storage.objects for delete to authenticated
  using (bucket_id = 'tickets' and public.is_admin());

-- ─── Realtime (live updates in every open browser) ──────────────────────────

do $$
declare t text;
begin
  foreach t in array array['investors', 'weeks', 'tickets', 'settings', 'profiles', 'draws'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ─── First admin ────────────────────────────────────────────────────────────
-- Creates a one-day admin invitation key until an admin account exists.
-- Copy the key shown in the result panel and use it on the "Join" tab.

do $$
begin
  if not exists (select 1 from public.profiles where role = 'admin')
     and not exists (select 1 from public.invites
                     where role = 'admin' and used_at is null and not revoked and expires_at > now()) then
    insert into public.invites (code, role, note, expires_at)
    values (public.gen_invite_code(), 'admin', 'First admin', now() + interval '1 day');
  end if;
end $$;

select public.format_invite(code) as admin_invite_key, expires_at
from public.invites
where role = 'admin' and used_at is null and not revoked and expires_at > now()
  and not exists (select 1 from public.profiles where role = 'admin');

-- Make the API pick up new columns/grants right away.
notify pgrst, 'reload schema';
