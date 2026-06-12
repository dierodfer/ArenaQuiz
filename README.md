# ArenaQuiz

App tipo Kahoot para encuestas en tiempo real con React (Vite) + Supabase Realtime.

## Setup

1. Crea un proyecto en [Supabase](https://supabase.com) y ejecuta `supabase/schema.sql` en el SQL Editor (crea tablas, políticas RLS y las funciones RPC).
2. Habilita el provider de email (suele venir activo por defecto): **Authentication → Providers → Email**.
   - Para probar en local sin configurar SMTP, puedes desactivar **"Confirm email"** en esa misma sección, así `signUp` deja al admin con sesión activa de inmediato.
3. Copia las credenciales:

   ```bash
   cp .env.example .env
   # Rellena VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY (Settings → API)
   ```

4. Instala y arranca:

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

- **Admin**: crea cuenta o inicia sesión con email + contraseña → crea sala (código de 6 chars) → abre la sala → agrega preguntas → cierra la sala → "Comenzar". El timer del admin cierra cada pregunta automáticamente y muestra resultados; "Siguiente" avanza hasta el ranking final. Solo el dueño de la sala (`admin_id = auth.uid()`) puede gestionarla.
- **Participante**: pone su nombre (sin cuenta) → entra con código o desde la lista de salas abiertas (solo si la sala está `open`) → responde A/B/C/D cuando el timer está activo. El servidor valida la respuesta y calcula el score (no el cliente). Todo se sincroniza por eventos Realtime de Supabase.

## Seguridad

- RLS está habilitado en las 4 tablas; los participantes (anónimos) solo pueden leer/escribir lo mínimo necesario (ver sección "Autenticación y RLS" en `CLAUDE.md`).
- La pregunta correcta (`correct_answer`) y las respuestas de otros nunca llegan al cliente del participante antes de `showing_results`: se obtienen mediante funciones RPC que filtran esos datos en el servidor.
- Si despliegas en GitHub Pages u otro hosting estático, recuerda añadir esa URL en **Authentication → URL Configuration → Site URL / Redirect URLs** de Supabase para que los enlaces de confirmación de email funcionen.

## Stack

- React 19 + Vite 8
- Tailwind CSS v4
- @supabase/supabase-js v2 (Realtime `postgres_changes`)
- Vitest + Testing Library
