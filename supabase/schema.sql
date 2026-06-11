-- ArenaQuiz · esquema de base de datos
-- Ejecutar en el SQL Editor de Supabase (proyecto nuevo).

create table rooms (
  id text primary key, -- código de 6 chars generado en cliente
  admin_id text not null,
  status text not null default 'waiting'
    check (status in ('waiting', 'open', 'closed', 'in_question', 'showing_results', 'finished')),
  current_question_index int not null default 0,
  time_per_question int not null default 15,
  created_at timestamptz not null default now()
);

create table participants (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references rooms(id) on delete cascade,
  username text not null,
  score int not null default 0,
  created_at timestamptz not null default now()
);

create table questions (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references rooms(id) on delete cascade,
  question_number int not null,
  title text not null,
  correct_answer text not null check (correct_answer in ('A', 'B', 'C', 'D')),
  options jsonb not null, -- ["texto A", "texto B", "texto C", "texto D"]
  created_at timestamptz not null default now(),
  unique (room_id, question_number)
);

create table answers (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  answer text not null check (answer in ('A', 'B', 'C', 'D')),
  is_correct boolean not null default false,
  created_at timestamptz not null default now(),
  unique (question_id, participant_id) -- una respuesta por participante y pregunta
);

-- Prototipo sin auth real: RLS deshabilitado, acceso total con la anon key.
alter table rooms disable row level security;
alter table participants disable row level security;
alter table questions disable row level security;
alter table answers disable row level security;

-- Realtime: habilitar eventos postgres_changes en las tablas que se escuchan.
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table participants;
alter publication supabase_realtime add table answers;
