-- ArenaQuiz · esquema de base de datos
-- Ejecutar en el SQL Editor de Supabase (proyecto nuevo).
--
-- Requiere autenticación por email/contraseña habilitada
-- (Authentication → Providers → Email). El admin se identifica con
-- auth.users; los participantes no requieren cuenta.
--
-- Este script es idempotente: primero elimina las tablas y funciones si ya
-- existen (CASCADE se lleva índices, policies y triggers asociados) y luego
-- recrea todo desde cero.

-- ============================================================
-- Limpieza
-- ============================================================
drop table if exists answers, room_questions, questions, participants, rooms cascade;

drop function if exists get_current_question(text);
drop function if exists get_question_stats(uuid);
drop function if exists submit_answer(uuid, uuid, text);
drop function if exists cleanup_finished_room(text);

-- ============================================================
-- Tablas
-- ============================================================

create table rooms (
  id text primary key, -- código de 6 chars generado en cliente
  admin_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 25),
  status text not null default 'waiting'
    check (status in ('waiting', 'open', 'closed', 'in_question', 'showing_results', 'finished')),
  current_question_index int not null default 0,
  time_per_question int not null default 15,
  finish_message text default '' check (char_length(finish_message) <= 100),
  -- URLs públicas (Supabase Storage, bucket room-images) de imágenes opcionales.
  -- logo_image sustituye al branding de la app dentro de la sala; finish_image
  -- se muestra en el ranking final. El cliente sube el archivo (~50KB máx.) al
  -- bucket y guarda aquí la URL pública.
  logo_image text default '' check (char_length(logo_image) <= 500),
  finish_image text default '' check (char_length(finish_image) <= 500),
  created_at timestamptz not null default now()
);

create table participants (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references rooms(id) on delete cascade,
  username text not null,
  email text, -- opcional: el participante puede dejarlo en blanco
  score int not null default 0,
  created_at timestamptz not null default now()
);

-- Consultada por sala (ranking, lobby en vivo); sin esto sería un full
-- table scan que empeora a medida que se acumulan sesiones.
create index participants_room_id_idx on participants (room_id);

-- questions: banco de preguntas del admin, independiente de las salas.
-- Una pregunta se crea una vez y puede reutilizarse en cualquier sala propia
-- a través de room_questions.
create table questions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references auth.users(id) on delete cascade,
  category text not null default 'General',
  title text not null,
  correct_answer text not null check (correct_answer in ('A', 'B', 'C', 'D')),
  options jsonb not null, -- ["texto A", "texto B", "texto C", "texto D"]
  created_at timestamptz not null default now()
);

-- Consultada para listar/filtrar el banco de preguntas de un admin por categoría.
create index questions_admin_id_idx on questions (admin_id);

-- room_questions: preguntas del banco elegidas para una sala concreta, con el
-- orden en que se presentan (question_number, 0-based, igual a
-- rooms.current_question_index).
create table room_questions (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references rooms(id) on delete cascade,
  question_id uuid not null references questions(id) on delete cascade,
  question_number int not null,
  unique (room_id, question_number),
  unique (room_id, question_id)
);

create index room_questions_room_id_idx on room_questions (room_id);

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
-- Permisos de tabla
-- ============================================================
-- Las políticas RLS de más abajo controlan QUÉ filas son visibles/editables,
-- pero antes de eso Postgres exige permisos a nivel de tabla para los roles
-- anon/authenticated (si no existen, el error es "permission denied for
-- table ..." en vez de "violates row-level security policy").

grant usage on schema public to anon, authenticated;

grant select on rooms to anon, authenticated;
grant insert, update on rooms to authenticated;

grant select on participants to anon, authenticated;
grant insert on participants to anon;
grant delete on participants to authenticated;

grant select, insert, update, delete on questions to authenticated;

grant select, insert on room_questions to authenticated;

grant select on answers to authenticated;

-- ============================================================
-- Row Level Security
-- ============================================================
-- El admin se autentica con Supabase Auth (email + contraseña) y solo puede
-- gestionar las salas y preguntas que creó (admin_id = auth.uid()). Los
-- participantes son anónimos: pueden unirse a salas abiertas y responder,
-- pero no pueden leer correct_answer ni modificar scores directamente; eso
-- pasa por las funciones RPC de más abajo (SECURITY DEFINER).

alter table rooms enable row level security;
alter table participants enable row level security;
alter table questions enable row level security;
alter table room_questions enable row level security;
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

-- El admin dueño de la sala puede expulsar participantes en el lobby (antes de
-- que empiece el juego); no se permite una vez que la sala arranca para no
-- alterar el ranking en curso.
create policy "participants_delete_own_room_lobby" on participants
  for delete to authenticated
  using (
    exists (
      select 1 from rooms
      where rooms.id = participants.room_id
        and rooms.admin_id = auth.uid()
        and rooms.status in ('waiting', 'open', 'closed')
    )
  );

-- questions: banco de preguntas privado de cada admin (CRUD completo sobre
-- las suyas). Los participantes nunca leen esta tabla directamente; obtienen
-- la pregunta actual, sin correct_answer hasta showing_results, vía
-- get_current_question().
create policy "questions_select_own" on questions
  for select to authenticated
  using (admin_id = auth.uid());

create policy "questions_insert_own" on questions
  for insert to authenticated
  with check (admin_id = auth.uid());

create policy "questions_update_own" on questions
  for update to authenticated
  using (admin_id = auth.uid())
  with check (admin_id = auth.uid());

create policy "questions_delete_own" on questions
  for delete to authenticated
  using (admin_id = auth.uid());

-- room_questions: el admin dueño de la sala asigna preguntas de su propio
-- banco al crearla.
create policy "room_questions_select_own_room" on room_questions
  for select to authenticated
  using (exists (select 1 from rooms where rooms.id = room_questions.room_id and rooms.admin_id = auth.uid()));

create policy "room_questions_insert_own_room" on room_questions
  for insert to authenticated
  with check (
    exists (select 1 from rooms where rooms.id = room_questions.room_id and rooms.admin_id = auth.uid())
    and exists (select 1 from questions where questions.id = room_questions.question_id and questions.admin_id = auth.uid())
  );

-- answers: solo el admin dueño de la pregunta puede leer las respuestas en
-- bruto (tally en vivo). El % de acierto para todos sale de
-- get_question_stats(). No hay policy de insert: solo se escribe vía
-- submit_answer().
create policy "answers_select_own" on answers
  for select to authenticated
  using (exists (select 1 from questions where questions.id = answers.question_id and questions.admin_id = auth.uid()));

-- ============================================================
-- Funciones RPC
-- ============================================================

-- Pregunta actual de una sala (vía room_questions). Oculta correct_answer
-- salvo en showing_results.
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
    q.id, rq.room_id, rq.question_number, q.title, q.options,
    case when r.status = 'showing_results' then q.correct_answer else null end
  from rooms r
  join room_questions rq on rq.room_id = r.id and rq.question_number = r.current_question_index
  join questions q on q.id = rq.question_id
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
-- is_correct ni el nuevo score. Idempotente: si ya existe la respuesta
-- (reconexión / doble clic) devuelve los datos almacenados sin error.
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
  v_existing record;
begin
  -- Si ya existe una respuesta para esta pregunta/participante, devolver la existente
  select a.is_correct, p.score into v_existing
    from answers a join participants p on p.id = a.participant_id
    where a.question_id = p_question_id and a.participant_id = p_participant_id;
  if found then
    return query select v_existing.is_correct, v_existing.score;
    return;
  end if;

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

-- Devuelve la respuesta de un participante a una pregunta concreta (si existe).
-- Usado por el cliente para restaurar el estado tras una reconexión a mitad de
-- pregunta, ya que RLS no le permite leer la tabla answers directamente.
create or replace function get_my_answer(p_question_id uuid, p_participant_id uuid)
returns table (answer text, is_correct boolean)
language sql
security definer
set search_path = public
as $$
  select answer, is_correct from answers
  where question_id = p_question_id and participant_id = p_participant_id;
$$;

grant execute on function get_my_answer(uuid, uuid) to anon, authenticated;

-- Limpia los datos efímeros de una sala terminada: la selección de preguntas
-- (room_questions) y las respuestas individuales (answers) de sus
-- participantes. Conserva rooms/participants (ranking final) y questions
-- (banco del admin, reutilizable en otras salas). Solo el admin dueño puede
-- ejecutarla, y solo cuando la sala ya está finished.
create or replace function cleanup_finished_room(p_room_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from rooms
    where id = p_room_id and admin_id = auth.uid() and status = 'finished'
  ) then
    raise exception 'room not found, not owned by caller, or not finished';
  end if;

  delete from answers
    where participant_id in (select id from participants where room_id = p_room_id);

  delete from room_questions where room_id = p_room_id;
end;
$$;

grant execute on function cleanup_finished_room(text) to authenticated;

-- ============================================================
-- Realtime
-- ============================================================
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table participants;
alter publication supabase_realtime add table answers;

-- Con la replica identity por defecto (solo la PK), el evento DELETE de
-- participants solo trae el id, así que un canal con filtro room_id=eq.X no lo
-- recibiría. FULL incluye la fila completa para que el filtro de expulsión en
-- el lobby del admin funcione.
alter table participants replica identity full;

-- ============================================================
-- Storage (imágenes de sala)
-- ============================================================
-- Bucket público para el logo y la imagen final que el admin sube al crear la
-- sala. Es público para que los participantes (anónimos) puedan verlas por su
-- URL; la subida queda restringida a admins autenticados por la policy de
-- abajo. El cliente limita el tamaño a ~50KB.
insert into storage.buckets (id, name, public)
values ('room-images', 'room-images', true)
on conflict (id) do update set public = true;

drop policy if exists "room_images_select_public" on storage.objects;
drop policy if exists "room_images_insert_auth" on storage.objects;
drop policy if exists "room_images_update_auth" on storage.objects;
drop policy if exists "room_images_delete_auth" on storage.objects;

-- Lectura pública (participantes ven el logo / imagen final sin cuenta).
create policy "room_images_select_public" on storage.objects
  for select using (bucket_id = 'room-images');

-- Solo admins autenticados pueden subir/reemplazar/borrar imágenes de sala.
create policy "room_images_insert_auth" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'room-images');

create policy "room_images_update_auth" on storage.objects
  for update to authenticated
  using (bucket_id = 'room-images')
  with check (bucket_id = 'room-images');

create policy "room_images_delete_auth" on storage.objects
  for delete to authenticated
  using (bucket_id = 'room-images');
