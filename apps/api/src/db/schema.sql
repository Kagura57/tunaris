create table if not exists profiles (
  user_id text primary key,
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
  user_id text,
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

create index if not exists idx_matches_room_code on matches(room_code);
create index if not exists idx_match_participants_match_id on match_participants(match_id);
create index if not exists idx_rounds_match_id on rounds(match_id);
create index if not exists idx_round_submissions_round_id on round_submissions(round_id);
