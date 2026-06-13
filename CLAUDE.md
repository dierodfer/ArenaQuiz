# CLAUDE.md

Guía para asistentes de IA trabajando en este repositorio.

## Qué es

ArenaQuiz es una app tipo Kahoot para encuestas en tiempo real: un admin crea una sala con preguntas y los participantes responden en vivo. Toda la sincronización se hace con eventos Realtime de Supabase (`postgres_changes`); no hay backend propio.

## Stack y comandos

- React 19 + Vite 8, Tailwind CSS v4 (vía `@tailwindcss/vite`, sin `tailwind.config.js`/`postcss.config.js`), `@supabase/supabase-js` v2.
- `npm run dev` — servidor de desarrollo.
- `npm run build` — build de producción (úsalo para verificar que compila).
- `npm run test` — corre los tests con Vitest (modo run, no watch). `npm run test:watch` para modo watch.
- No hay linter configurado.
- CI: `.github/workflows/ci.yml` corre `npm ci`, `npm run test` y `npm run build` en push/PR a `main`.
- Credenciales: `.env` con `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY` (ver `.env.example`). Nunca commitear `.env`.

## Estructura

```
src/
  App.jsx                # TODA la app: flujos admin y participante, hooks, UI
  App.logic.test.jsx     # tests de generateRoomCode y useQuestionTimer (Vitest)
  App.render.test.jsx    # tests de renderizado/navegación con supabase mockeado
  setupTests.js          # setup de Vitest (@testing-library/jest-dom)
  supabaseClient.js       # cliente Supabase singleton
  main.jsx               # entry point
  index.css              # @import "tailwindcss" + clases .input/.btn (@layer components)
supabase/
  schema.sql             # esquema completo de BD (ejecutar en SQL Editor de Supabase)
```

Convención deliberada: la app vive en un solo archivo `src/App.jsx`. No la dividas en múltiples archivos/carpetas de componentes salvo que el usuario lo pida.

## Modelo de datos (4 tablas)

- `rooms`: `id` (texto, código de 6 chars generado en cliente), `admin_id` (uuid, FK a `auth.users`), `status`, `current_question_index`, `time_per_question`.
- `participants`: FK a room, `username`, `score`.
- `questions`: FK a room, `question_number` (0-based, igual a `current_question_index`), `title`, `options` (jsonb, array de 4 textos), `correct_answer` (letra A-D).
- `answers`: FK a question y participant, `answer` (letra), `is_correct`. Unique por (question_id, participant_id).

Las tablas `rooms`, `participants` y `answers` están en la publicación `supabase_realtime`.

## Autenticación y RLS (crítico)

- El admin se autentica con **Supabase Auth (email + contraseña)**; `rooms.admin_id = auth.uid()`. Los participantes NO tienen cuenta (solo username), tal como pide el flujo simple.
- **No hay auto-registro**: "Allow new users to sign up" está desactivado en Supabase. `AdminAuth` (en `App.jsx`) solo tiene login, no signup. Las cuentas de admin las crea el dueño del proyecto manualmente desde Authentication → Users → "Add user" (con "Auto Confirm User"). Ver README sección "Administradores".
- RLS está **habilitado** en las 4 tablas (ver `supabase/schema.sql`):
  - `rooms`/`participants`: SELECT abierto a todos (lobby, ranking). `rooms` solo se puede INSERT/UPDATE si `admin_id = auth.uid()`. `participants` solo se puede INSERT si la sala está `open`.
  - `questions`/`answers`: solo legibles/escribibles por el admin dueño de la sala (vía join a `rooms.admin_id = auth.uid()`). Los participantes nunca leen estas tablas directamente.
- Los participantes acceden a la pregunta y a las estadísticas vía **funciones RPC** (`security definer`, bypasean RLS de forma controlada):
  - `get_current_question(p_room_id)`: devuelve la pregunta actual; `correct_answer` viene `null` salvo cuando `status = 'showing_results'`.
  - `get_question_stats(p_question_id)`: devuelve `{ total, correct }` agregados, sin exponer respuestas individuales.
  - `submit_answer(p_question_id, p_participant_id, p_answer)`: inserta la respuesta, calcula `is_correct` en el servidor y suma +100 al score si es correcta de forma atómica. El cliente nunca decide si acertó ni el nuevo score.
- `useCurrentQuestion` y `useQuestionStats` (compartidos por admin y participante) llaman siempre a estas RPC, no a las tablas directamente. El admin sigue leyendo `questions`/`answers` directamente solo en `QuestionForm` y en el tally en vivo de `AdminRoom` (permitido por RLS al ser el dueño).
- Si añades nuevas queries desde el cliente, comprueba si necesitan política RLS nueva en `schema.sql` o si deben pasar por una función `security definer`.

## Máquina de estados de la sala (crítico)

`rooms.status` es la única fuente de verdad y SOLO el admin la modifica:

```
waiting → open → closed → in_question ⇄ showing_results → finished
```

- `open`: los participantes pueden unirse (se valida en el join); el admin agrega preguntas.
- `in_question` → `showing_results`: lo dispara automáticamente el timer del ADMIN al llegar a 0.
- `showing_results` → `in_question`: botón "Siguiente" incrementa `current_question_index` y vuelve a `in_question` en el mismo UPDATE. Si no quedan preguntas → `finished`.

## Arquitectura de eventos y timing

- Todos los clientes (admin y participantes) se suscriben a UPDATEs de su fila de `rooms` (`useRoomSubscription`). Cualquier cambio de `status` o `current_question_index` propaga la transición instantáneamente.
- El admin además escucha INSERTs en `participants` (lobby en vivo) e INSERTs en `answers` filtrados por la pregunta actual (respuestas en vivo). El canal de answers se recrea por pregunta.
- El timer es 100% cliente (`useQuestionTimer`): al entrar en `in_question` hay 3s de fase "lea" (sin timer visible, opciones deshabilitadas) y después la cuenta atrás oficial de `time_per_question` segundos.
- Solo el timer del admin tiene efectos: al llegar a 0 actualiza `status = 'showing_results'`. El timer del participante es puramente visual; cuando llega a 0 solo deshabilita las opciones y espera el evento.
- `is_correct` y el score (+100 por acierto) se calculan en el servidor (`submit_answer` RPC). El % de acierto se obtiene de `get_question_stats` al entrar en `showing_results`.

## Convenciones

- UI en español; código (variables, funciones) en inglés.
- Estilos solo con Tailwind; las clases compartidas `.input` y `.btn` están en `index.css`.
- Las letras A-D y sus colores viven en las constantes `LETTERS` y `LETTER_COLORS` de `App.jsx`; `options[i]` se corresponde con `LETTERS[i]`.
- Si cambias el esquema de BD, actualiza `supabase/schema.sql` (es la referencia canónica; no hay migraciones).

## Tests

- `App.jsx` importa `supabaseClient.js` a nivel de módulo, que llama a `createClient`. Cualquier test que importe algo de `App.jsx` debe mockear `./supabaseClient` con `vi.mock(...)` para evitar el error de credenciales faltantes.
- Funciones/hooks puros que se quieran testear unitariamente (p.ej. `generateRoomCode`, `useQuestionTimer`) deben exportarse con `export` desde `App.jsx`; sigue siendo un solo archivo, solo se exponen para los tests.
- `useQuestionTimer` dispara `onTimeUp` en el mismo ciclo de efecto en que `timeLeft` llega a 0 (no un segundo después). Al testear con fake timers, usa un `act()` por cada `advanceTimersByTime` de 1s para que los `setTimeout` encadenados se procesen uno a uno.
- Para tests de renderizado que toquen componentes con llamadas a Supabase (p.ej. `ParticipantApp` que hace `from('rooms').select()...` al montar), mockea `supabase.from()` devolviendo un query builder encadenable thenable (`select/eq/order/single/insert/update` devuelven el mismo objeto, y `.then()` resuelve `{ data, error }`), y `supabase.channel()` devolviendo un objeto con `on()`/`subscribe()` encadenables.
