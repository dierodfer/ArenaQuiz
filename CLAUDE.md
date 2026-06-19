# CLAUDE.md

Guía para asistentes de IA trabajando en este repositorio.

## Qué es

ArenaQuiz es una app tipo Kahoot para encuestas en tiempo real: un admin crea una sala con preguntas y los participantes responden en vivo. Toda la sincronización se hace con eventos Realtime de Supabase (`postgres_changes`); no hay backend propio.

## Stack y comandos

- React 19 + Vite 8, Tailwind CSS v4 (vía `@tailwindcss/vite`, sin `tailwind.config.js`/`postcss.config.js`), `@supabase/supabase-js` v2.
- UI: `lucide-react` (iconografía) y `framer-motion` (animaciones de entrada/feedback). Mantén las animaciones ligeras (solo opacidad/transform); el podio del ranking solo anima el top 3 para no lanzar cientos de animaciones con muchos participantes.
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

## Modelo de datos (5 tablas)

- `rooms`: `id` (texto, código de 6 chars generado en cliente), `admin_id` (uuid, FK a `auth.users`), `name` (obligatorio, máx. 25 chars, validado en cliente con `validateRoomName` y por `check` en BD), `status`, `current_question_index`, `time_per_question`, `finish_message` (texto opcional, máx. 100 chars — mensaje personalizado que aparece en el ranking al terminar la encuesta), `logo_image` y `finish_image` (URLs públicas opcionales de imágenes en Supabase Storage; ver sección "Imágenes de sala").
- `participants`: FK a room, `username` (3-10 chars, validado en cliente con `validateUsername`), `email` (opcional, máx. 50 chars, `validateEmail`), `score`. El admin dueño puede expulsar participantes en el lobby (botón "Editar" en `AdminRoom`, estado `open`); el DELETE se propaga por realtime (`replica identity full` para que el filtro por `room_id` reciba el evento).
- `questions`: **banco de preguntas del admin, desacoplado de las salas**. `admin_id` (uuid, FK a `auth.users`), `category` (texto libre, default `'General'`), `title`, `options` (jsonb, array de 2 a 4 textos — el formulario manual siempre crea 4, la importación JSON admite 2-4), `correct_answer` (letra A-D según la posición en `options`). Una pregunta se crea una vez y se reutiliza en cualquier sala propia. La UI (`AnswerBreakdown`, `ParticipantRoom`) itera sobre `question.options`, no sobre `LETTERS` fijo, para soportar menos de 4 opciones.
- `room_questions`: tabla de unión sala↔pregunta. FK a room y question, `question_number` (0-based, igual a `current_question_index`). Define qué preguntas y en qué orden juega cada sala. Unique por `(room_id, question_number)` y `(room_id, question_id)`.
- `answers`: FK a question y participant, `answer` (letra), `is_correct`. Unique por (question_id, participant_id).

Las tablas `rooms`, `participants` y `answers` están en la publicación `supabase_realtime`.

## Autenticación y RLS (crítico)

- El admin se autentica con **Supabase Auth (email + contraseña)**; `rooms.admin_id = auth.uid()`. Los participantes NO tienen cuenta (solo username), tal como pide el flujo simple.
- **No hay auto-registro**: "Allow new users to sign up" está desactivado en Supabase. `AdminAuth` (en `App.jsx`) solo tiene login, no signup. Las cuentas de admin las crea el dueño del proyecto manualmente desde Authentication → Users → "Add user" (con "Auto Confirm User"). Ver README sección "Administradores".
- RLS está **habilitado** en las 5 tablas (ver `supabase/schema.sql`):
  - `rooms`/`participants`: SELECT abierto a todos (lobby, ranking). `rooms` solo se puede INSERT/UPDATE si `admin_id = auth.uid()`. `participants` solo se puede INSERT si la sala está `open`, y solo el admin dueño puede DELETE mientras la sala no haya arrancado (`status in ('waiting','open','closed')`).
  - `questions`: CRUD completo (SELECT/INSERT/UPDATE/DELETE) solo para el admin dueño (`admin_id = auth.uid()`) — es su banco privado. Los participantes nunca la leen directamente.
  - `room_questions`: SELECT/INSERT solo para el admin dueño de la sala (join a `rooms.admin_id = auth.uid()`; el INSERT exige además que la pregunta sea suya).
  - `answers`: solo legibles por el admin dueño de la pregunta (join a `questions.admin_id = auth.uid()`).
- Los participantes acceden a la pregunta y a las estadísticas vía **funciones RPC** (`security definer`, bypasean RLS de forma controlada):
  - `get_current_question(p_room_id)`: devuelve la pregunta actual (join `rooms`→`room_questions`→`questions`); `correct_answer` viene `null` salvo cuando `status = 'showing_results'`.
  - `get_question_stats(p_question_id)`: devuelve `{ total, correct }` agregados, sin exponer respuestas individuales.
  - `submit_answer(p_question_id, p_participant_id, p_answer)`: inserta la respuesta, calcula `is_correct` en el servidor y suma +100 al score si es correcta de forma atómica. El cliente nunca decide si acertó ni el nuevo score.
- `useCurrentQuestion` y `useQuestionStats` (compartidos por admin y participante) llaman siempre a estas RPC, no a las tablas directamente. El admin sí lee `questions`/`room_questions`/`answers` directamente en `QuestionBank`, `CreateRoom` y el tally en vivo de `AdminRoom` (permitido por RLS al ser el dueño).
- `cleanup_finished_room(p_room_id)`: al llegar a `finished`, borra `room_questions` y `answers` de esa sala (conserva `rooms`/`participants` para el ranking y `questions`, que es el banco del admin). Solo el admin dueño puede ejecutarla, y solo si la sala ya está `finished`.
- Si añades nuevas queries desde el cliente, comprueba si necesitan política RLS nueva en `schema.sql` o si deben pasar por una función `security definer`.

## Máquina de estados de la sala (crítico)

`rooms.status` es la única fuente de verdad y SOLO el admin la modifica:

```
waiting → open → closed → in_question ⇄ showing_results → finished
```

- Las preguntas NO se crean dentro de la sala: el admin las gestiona antes en el **banco** (`QuestionBank`) y al **crear la sala** (`CreateRoom`) elige una categoría y, dentro de ella, las preguntas concretas (el orden de selección es el orden de juego; hay un botón "Seleccionar todas" / "Deseleccionar todas" cuando la categoría tiene más de 1 pregunta). Esto inserta las filas de `room_questions`.
- `waiting`: la sala ya tiene sus preguntas elegidas; el admin las ve en modo lectura y puede abrirla.
- `open`: los participantes pueden unirse (se valida en el join).
- `in_question` → `showing_results`: lo dispara automáticamente el timer del ADMIN al llegar a 0, o manualmente el admin con el botón "Saltar pregunta" (`closeQuestion`, misma transición que `onTimeUp`).
- `showing_results` → `in_question`: botón "Siguiente" incrementa `current_question_index` y vuelve a `in_question` en el mismo UPDATE. Si no quedan preguntas → `finished`.
- Cualquier estado de juego (`in_question`/`showing_results`) → `finished`: el admin puede saltar el resto de la encuesta e ir directo al ranking con el botón "Finalizar encuesta" (`skipSurvey`, con `window.confirm`; ambos caminos pasan por `finishSurvey`).
- Al llegar a `finished`, el admin llama además a `cleanup_finished_room` (RPC) para borrar los datos efímeros de la sala (ver sección RLS). Tanto admin ("Volver al menú") como participante ("Volver al inicio") tienen un botón para salir de la sala tras el ranking; el del participante (`onHome`) vuelve a la pantalla de selección de rol.

## Imágenes de sala (Supabase Storage)

- Al crear la sala el admin puede subir, de forma **opcional**, dos imágenes (componente `ImageUploadField`, idealmente SVG, límite cliente de `IMAGE_MAX_BYTES` = 50KB):
  - **Logo de sala** (`logo_image`): sustituye al branding de la app (`Target` + "ArenaQuiz") en el `Header` mientras estás dentro de la sala, en todas las pantallas, tanto admin como participante. Se propaga vía el contexto `RoomBrandingContext`: `AdminRoom`/`ParticipantRoom` publican `room.logo_image` con `setRoomLogo` al montar y lo limpian (`null`) al desmontar; el `Header` lo consume y muestra `<img>` en lugar del logo por defecto.
  - **Imagen final** (`finish_image`): se muestra en la vista de ranking (`Ranking`, prop `finishImage`) al terminar la encuesta.
- Las imágenes se suben al bucket **público** `room-images` de Supabase Storage (`uploadRoomImage`, ruta `${roomId}/${kind}.${ext}`, `upsert: true`) y en `rooms` se guarda solo la **URL pública** (no la imagen inline). El bucket y sus policies están en `schema.sql` (sección Storage): lectura pública (participantes anónimos), subida/borrado solo para `authenticated`.
- Se renderizan siempre con `<img src>` (no `dangerouslySetInnerHTML`), por lo que un SVG no ejecuta scripts.
- Si re-ejecutas `schema.sql` en un proyecto existente, además de las tablas crea/actualiza el bucket `room-images` y sus policies de `storage.objects`.

## Arquitectura de eventos y timing

- Todos los clientes (admin y participantes) se suscriben a UPDATEs de su fila de `rooms` (`useRoomSubscription`). Cualquier cambio de `status` o `current_question_index` propaga la transición instantáneamente.
- El admin además escucha, vía hooks dedicados, eventos de `participants` (`useLobbyParticipants`: INSERT para el lobby en vivo y DELETE para la expulsión) e INSERTs en `answers` filtrados por la pregunta actual (`useLiveAnswers`; el canal se recrea por pregunta). **Optimización de consumo (capa gratuita):** `useLobbyParticipants` NO escucha UPDATE de `participants` —la única actualización es el score, que sube `submit_answer` en cada acierto y el admin no muestra en vivo— para no recibir un mensaje de Realtime por cada respuesta correcta. Los `select` piden solo las columnas usadas (`id, username` en participantes; `answer, is_correct` en respuestas; `id, name, created_at` en la lista de salas abiertas), no `*`.
- El timer es 100% cliente (`useQuestionTimer`): al entrar en `in_question` hay 3s de fase "lea" (sin timer visible, opciones deshabilitadas) y después la cuenta atrás oficial de `time_per_question` segundos. Durante la fase `answering` se muestra, además del número, una barra de progreso (`TimerBar`) tanto en admin como en participante.
- Solo el timer del admin tiene efectos: al llegar a 0 actualiza `status = 'showing_results'`. El timer del participante es puramente visual; cuando llega a 0 solo deshabilita las opciones y espera el evento.
- En la vista de monitoreo del admin, `AnswerBreakdown` muestra cada respuesta posible (texto de la opción) y, justo debajo, el % y el número de respuestas; solo se renderiza en `showing_results` (durante `in_question` el admin solo ve el contador de respuestas recibidas, sin desglose, para no filtrar la tendencia mientras se puede seguir respondiendo). Con la prop `totalParticipants` añade una fila final "No respondido" (participantes que no contestaron, con su % sobre el total). Los `liveAnswers` se siguen recolectando durante `in_question` y solo se limpian al cambiar de pregunta, para que el desglose esté listo en cuanto se agote el tiempo.
- El texto de las preguntas y de las opciones de respuesta no se puede seleccionar ni copiar (`NoCopy`: `select-none` + bloqueo de `copy`/`contextmenu`), tanto en la vista de admin como en la de participante.
- `is_correct` y el score (+100 por acierto) se calculan en el servidor (`submit_answer` RPC). El % de acierto en la vista del **participante** se obtiene de `get_question_stats` (RPC) al entrar en `showing_results`, porque RLS no le deja leer `answers`. El **admin**, en cambio, NO llama a ese RPC: deriva `{ total, correct, pct }` con `useMemo` a partir de los `liveAnswers` que ya tiene (incluyen `is_correct`), ahorrando un RPC por pregunta.

## Convenciones

- UI en español; código (variables, funciones) en inglés.
- Estilos solo con Tailwind; las clases compartidas `.input`/`.btn`/`.btn-secondary`/`.btn-ghost` están en `index.css`.
- Paleta neutra (`zinc`) + un único acento (`indigo`). Evita colores saturados salvo en las 4 respuestas (`LETTER_META`), que combinan color + forma + letra por accesibilidad.
- Tema claro/oscuro por clase `.dark` en `<html>` (variante Tailwind v4 `@custom-variant dark` en `index.css`). El hook `useTheme` la sincroniza y persiste en `localStorage` (`aq-theme`); un script inline en `index.html` la aplica antes de pintar para evitar parpadeo. Usa siempre variantes `dark:` en el JSX.
- Primitivas de UI reutilizables en `App.jsx`: `Stage` (ancho), `Panel`, `ScreenHeader`, `MenuCard`, `StatusBadge`, `Stat`, `RoomCode`, `selectClasses` (botones de selección única). La vista de sala (`AdminRoom`) usa `Stage wide` por estar pensada para proyección.
- Las letras A-D, sus colores y formas viven en `LETTERS` y `LETTER_META` de `App.jsx`; `options[i]` se corresponde con `LETTERS[i]`.
- Si cambias el esquema de BD, actualiza `supabase/schema.sql` (es la referencia canónica; no hay migraciones).
- `QuestionBank` permite importar preguntas en lote pegando un JSON con forma `{ titulo, preguntas: [{ pregunta, opciones, respuesta_correcta }] }` (ver `parseQuestionImport`, exportada y testeada). `titulo` se usa como `category` para todas las preguntas importadas; `respuesta_correcta` debe coincidir textualmente con una de `opciones` (2-4) y se traduce a su letra A-D por posición. El parseo es todo-o-nada: si una pregunta del array es inválida, no se inserta ninguna.

## Tests

- `App.jsx` importa `supabaseClient.js` a nivel de módulo, que llama a `createClient`. Cualquier test que importe algo de `App.jsx` debe mockear `./supabaseClient` con `vi.mock(...)` para evitar el error de credenciales faltantes.
- Funciones/hooks puros que se quieran testear unitariamente (p.ej. `generateRoomCode`, `useQuestionTimer`) deben exportarse con `export` desde `App.jsx`; sigue siendo un solo archivo, solo se exponen para los tests.
- `useQuestionTimer` dispara `onTimeUp` en el mismo ciclo de efecto en que `timeLeft` llega a 0 (no un segundo después). Al testear con fake timers, usa un `act()` por cada `advanceTimersByTime` de 1s para que los `setTimeout` encadenados se procesen uno a uno.
- Para tests de renderizado que toquen componentes con llamadas a Supabase (p.ej. `ParticipantApp` que hace `from('rooms').select()...` al montar, o `QuestionBank` que hace `from('questions').select().eq().order().order()`), mockea `supabase.from()` devolviendo un query builder encadenable thenable (`select/eq/order/single/insert/update/delete` devuelven el mismo objeto, y `.then()` resuelve `{ data, error }`), y `supabase.channel()` devolviendo un objeto con `on()`/`subscribe()` encadenables.
