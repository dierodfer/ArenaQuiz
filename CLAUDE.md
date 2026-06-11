# CLAUDE.md

Guía para asistentes de IA trabajando en este repositorio.

## Qué es

ArenaQuiz es una app tipo Kahoot para encuestas en tiempo real: un admin crea una sala con preguntas y los participantes responden en vivo. Toda la sincronización se hace con eventos Realtime de Supabase (`postgres_changes`); no hay backend propio.

## Stack y comandos

- React 18 + Vite, Tailwind CSS, `@supabase/supabase-js` v2.
- `npm run dev` — servidor de desarrollo.
- `npm run build` — build de producción (úsalo para verificar que compila).
- No hay tests ni linter configurados.
- Credenciales: `.env` con `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` (ver `.env.example`). Nunca commitear `.env`.

## Estructura

```
src/
  App.jsx            # TODA la app: flujos admin y participante, hooks, UI
  supabaseClient.js  # cliente Supabase singleton
  main.jsx           # entry point
  index.css          # Tailwind + clases .input/.btn (@layer components)
supabase/
  schema.sql         # esquema completo de BD (ejecutar en SQL Editor de Supabase)
```

Convención deliberada: la app vive en un solo archivo `src/App.jsx`. No la dividas en múltiples archivos/carpetas de componentes salvo que el usuario lo pida.

## Modelo de datos (4 tablas)

- `rooms`: `id` (texto, código de 6 chars generado en cliente), `admin_id`, `status`, `current_question_index`, `time_per_question`.
- `participants`: FK a room, `username`, `score`.
- `questions`: FK a room, `question_number` (0-based, igual a `current_question_index`), `title`, `options` (jsonb, array de 4 textos), `correct_answer` (letra A-D).
- `answers`: FK a question y participant, `answer` (letra), `is_correct`. Unique por (question_id, participant_id).

RLS está deshabilitado a propósito (prototipo sin auth real; el "token" de admin es cualquier string). Las tablas `rooms`, `participants` y `answers` están en la publicación `supabase_realtime`.

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
- `is_correct` y el score (+100 por acierto) se calculan en el cliente del participante al responder. El % de acierto se calcula consultando `answers` al entrar en `showing_results`.

## Convenciones

- UI en español; código (variables, funciones) en inglés.
- Estilos solo con Tailwind; las clases compartidas `.input` y `.btn` están en `index.css`.
- Las letras A-D y sus colores viven en las constantes `LETTERS` y `LETTER_COLORS` de `App.jsx`; `options[i]` se corresponde con `LETTERS[i]`.
- Si cambias el esquema de BD, actualiza `supabase/schema.sql` (es la referencia canónica; no hay migraciones).
