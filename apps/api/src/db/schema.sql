create table if not exists "user" (
  id text primary key,
  name text not null,
  email text not null unique,
  "emailVerified" boolean not null default false,
  image text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists session (
  id text primary key,
  "expiresAt" timestamptz not null,
  token text not null unique,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user"(id) on delete cascade
);

create table if not exists account (
  id text primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user"(id) on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("providerId", "accountId")
);

create table if not exists verification (
  id text primary key,
  identifier text not null,
  value text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists profiles (
  user_id text primary key references "user"(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists matches (
  id bigserial primary key,
  room_code text not null,
  config jsonb not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists match_participants (
  id bigserial primary key,
  match_id bigint not null references matches(id) on delete cascade,
  player_id text not null,
  user_id text references "user"(id) on delete set null,
  display_name text not null,
  final_rank integer,
  score integer not null default 0,
  max_streak integer not null default 0
);

create table if not exists rounds (
  id bigserial primary key,
  match_id bigint not null references matches(id) on delete cascade,
  round_index integer not null,
  answer_mode text not null check (answer_mode in ('mcq', 'text')),
  preview_url text not null,
  started_at timestamptz,
  deadline_at timestamptz,
  reveal_at timestamptz
);

create table if not exists round_submissions (
  id bigserial primary key,
  round_id bigint not null references rounds(id) on delete cascade,
  player_id text not null,
  answer_value text not null,
  accepted boolean not null default true,
  submitted_at timestamptz not null default now(),
  response_ms integer,
  earned_score integer not null default 0
);

create table if not exists provider_tracks (
  id bigserial primary key,
  provider text not null,
  provider_track_id text not null,
  title text not null,
  artist text not null,
  preview_url text not null,
  fetched_at timestamptz not null default now(),
  unique (provider, provider_track_id)
);

create table if not exists music_account_links (
  id bigserial primary key,
  user_id text not null references "user"(id) on delete cascade,
  provider text not null check (provider in ('spotify', 'deezer')),
  provider_user_id text,
  access_token text not null,
  refresh_token text,
  scope text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create index if not exists idx_matches_room_code on matches(room_code);
create index if not exists idx_match_participants_match_id on match_participants(match_id);
create index if not exists idx_rounds_match_id on rounds(match_id);
create index if not exists idx_round_submissions_round_id on round_submissions(round_id);
create index if not exists idx_music_account_links_user_id on music_account_links(user_id);
create index if not exists idx_session_user_id on session("userId");
create index if not exists idx_account_user_id on account("userId");
create index if not exists idx_verification_identifier on verification(identifier);
