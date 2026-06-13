-- ArenaQuiz · esquema de base de datos
-- Ejecutar en el SQL Editor de Supabase (proyecto nuevo).
--
-- Requiere autenticación por email/contraseña habilitada
-- (Authentication → Providers → Email). El admin se identifica con
-- auth.users; los participantes no requieren cuenta.

create table rooms (
  id text primary key, -- código de 6 chars generado en cliente
  admin_id uuid not null references auth.users(id) on delete cascade,
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

-- Consultada por sala (ranking, lobby en vivo); sin esto sería un full
-- table scan que empeora a medida que se acumulan sesiones.
create index participants_room_id_idx on participants (room_id);

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

-- ============================================================
-- Row Level Security
-- ============================================================
-- El admin se autentica con Supabase Auth (email + contraseña) y solo puede
-- gestionar las salas que creó (admin_id = auth.uid()). Los participantes
-- son anónimos: pueden unirse a salas abiertas y responder, pero no pueden
-- leer correct_answer ni modificar scores directamente; eso pasa por las
-- funciones RPC de más abajo (SECURITY DEFINER).

alter table rooms enable row level security;
alter table participants enable row level security;
alter table questions enable row level security;
alter table answers enable row level security;

-- rooms: visibles para todos (lobby de salas abiertas); solo el admin dueño
-- puede crearlas/modificarlas.
create policy "rooms_select_all" on rooms
  for select using (true);

create policy "rooms_insert_own" on rooms
  for insert to authenticated
  with check (admin_id = auth.uid());

create policy "rooms_update_own" on rooms
  for update to authenticated
  using (admin_id = auth.uid())
  with check (admin_id = auth.uid());

-- participants: visibles para todos (lobby y ranking); cualquiera puede
-- unirse mientras la sala esté "open". El score solo se actualiza vía
-- submit_answer().
create policy "participants_select_all" on participants
  for select using (true);

create policy "participants_insert_if_room_open" on participants
  for insert
  with check (
    exists (select 1 from rooms where rooms.id = participants.room_id and rooms.status = 'open')
  );

-- questions: solo el admin dueño de la sala puede leer/crear preguntas
-- (incluye correct_answer). Los participantes obtienen la pregunta actual,
-- sin correct_answer hasta showing_results, vía get_current_question().
create policy "questions_select_own_room" on questions
  for select to authenticated
  using (exists (select 1 from rooms where rooms.id = questions.room_id and rooms.admin_id = auth.uid()));

create policy "questions_insert_own_room" on questions
  for insert to authenticated
  with check (exists (select 1 from rooms where rooms.id = questions.room_id and rooms.admin_id = auth.uid()));

-- answers: solo el admin dueño puede leer las respuestas en bruto (tally en
-- vivo). El % de acierto para todos sale de get_question_stats(). No hay
-- policy de insert: solo se escribe vía submit_answer().
create policy "answers_select_own_room" on answers
  for select to authenticated
  using (exists (
    select 1 from questions q
    join rooms r on r.id = q.room_id
    where q.id = answers.question_id and r.admin_id = auth.uid()
  ));

-- ============================================================
-- Funciones RPC
-- ============================================================

-- Pregunta actual de una sala. Oculta correct_answer salvo en showing_results.
create or replace function get_current_question(p_room_id text)
returns table (
  id uuid,
  room_id text,
  question_number int,
  title text,
  options jsonb,
  correct_answer text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    q.id, q.room_id, q.question_number, q.title, q.options,
    case when r.status = 'showing_results' then q.correct_answer else null end
  from rooms r
  join questions q on q.room_id = r.id and q.question_number = r.current_question_index
  where r.id = p_room_id;
$$;

grant execute on function get_current_question(text) to anon, authenticated;

-- % de acierto de una pregunta, sin exponer las respuestas individuales.
create or replace function get_question_stats(p_question_id uuid)
returns table (total int, correct int)
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::int as total, count(*) filter (where is_correct)::int as correct
  from answers
  where question_id = p_question_id;
$$;

grant execute on function get_question_stats(uuid) to anon, authenticated;

-- Registra la respuesta de un participante: el servidor decide si es
-- correcta y actualiza el score de forma atómica. El cliente nunca calcula
-- is_correct ni el nuevo score.
create or replace function submit_answer(p_question_id uuid, p_participant_id uuid, p_answer text)
returns table (is_correct boolean, new_score int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_correct text;
  v_is_correct boolean;
  v_new_score int;
begin
  select correct_answer into v_correct from questions where id = p_question_id;
  if v_correct is null then
    raise exception 'question not found';
  end if;

  v_is_correct := (p_answer = v_correct);

  insert into answers (question_id, participant_id, answer, is_correct)
  values (p_question_id, p_participant_id, p_answer, v_is_correct);

  if v_is_correct then
    update participants set score = score + 100
      where id = p_participant_id
      returning score into v_new_score;
  else
    select score into v_new_score from participants where id = p_participant_id;
  end if;

  return query select v_is_correct, v_new_score;
end;
$$;

grant execute on function submit_answer(uuid, uuid, text) to anon, authenticated;

-- ============================================================
-- Realtime
-- ============================================================
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table participants;
alter publication supabase_realtime add table answers;
