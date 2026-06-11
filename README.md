# ArenaQuiz

App tipo Kahoot para encuestas en tiempo real con React (Vite) + Supabase Realtime.

## Setup

1. Crea un proyecto en [Supabase](https://supabase.com) y ejecuta `supabase/schema.sql` en el SQL Editor.
2. Copia las credenciales:

   ```bash
   cp .env.example .env
   # Rellena VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY (Settings → API)
   ```

3. Instala y arranca:

   ```bash
   npm install
   npm run dev
   ```

## Tests

```bash
npm run test       # corre los tests una vez (Vitest)
npm run test:watch # modo watch
```

CI (`.github/workflows/ci.yml`) corre los tests y el build en cada push/PR a `main`.

## Uso

- **Admin**: login con cualquier token → crea sala (código de 6 chars) → abre la sala → agrega preguntas → cierra la sala → "Comenzar". El timer del admin cierra cada pregunta automáticamente y muestra resultados; "Siguiente" avanza hasta el ranking final.
- **Participante**: pone su nombre → entra con código o desde la lista de salas abiertas (solo si la sala está `open`) → responde A/B/C/D cuando el timer está activo. Todo se sincroniza por eventos Realtime de Supabase.

## Stack

- React 19 + Vite 8
- Tailwind CSS v4
- @supabase/supabase-js v2 (Realtime `postgres_changes`)
- Vitest + Testing Library
