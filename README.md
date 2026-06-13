# ArenaQuiz

App tipo Kahoot para encuestas en tiempo real con React (Vite) + Supabase Realtime.

## Setup

1. Crea un proyecto en [Supabase](https://supabase.com) y ejecuta `supabase/schema.sql` en el SQL Editor (crea tablas, políticas RLS y las funciones RPC).
2. **Authentication → Sign In / Providers**:
   - Desactiva **"Allow new users to sign up"** (sección "User Signups"). No hay auto-registro: las cuentas de admin se crean manualmente (ver sección "Administradores" más abajo).
   - Deja **"Confirm email"** activado (valor por defecto).
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

## Administradores

No hay auto-registro: el toggle "Allow new users to sign up" debe estar desactivado en Supabase. Para dar acceso de admin a alguien:

1. **Authentication → Users → "Add user"** en el dashboard de Supabase.
2. Introduce su email y una contraseña.
3. Marca **"Auto Confirm User"** para que quede activo de inmediato (sin email de confirmación).

Esa persona ya puede entrar en "Soy Admin" → login con esas credenciales y crear sus propias salas.

## Uso

- **Admin**: inicia sesión con email + contraseña (cuenta creada por el dueño del proyecto, ver arriba) → crea sala (código de 6 chars) → abre la sala → agrega preguntas → cierra la sala → "Comenzar". El timer del admin cierra cada pregunta automáticamente y muestra resultados; "Siguiente" avanza hasta el ranking final. Solo el dueño de la sala (`admin_id = auth.uid()`) puede gestionarla.
- **Participante**: pone su nombre (sin cuenta) → entra con código o desde la lista de salas abiertas (solo si la sala está `open`) → responde A/B/C/D cuando el timer está activo. El servidor valida la respuesta y calcula el score (no el cliente). Todo se sincroniza por eventos Realtime de Supabase.

## Seguridad

- RLS está habilitado en las 4 tablas; los participantes (anónimos) solo pueden leer/escribir lo mínimo necesario (ver sección "Autenticación y RLS" en `CLAUDE.md`).
- La pregunta correcta (`correct_answer`) y las respuestas de otros nunca llegan al cliente del participante antes de `showing_results`: se obtienen mediante funciones RPC que filtran esos datos en el servidor.
- Si despliegas en GitHub Pages u otro hosting estático, recuerda añadir esa URL en **Authentication → URL Configuration → Site URL / Redirect URLs** de Supabase para que los enlaces de confirmación de email funcionen.
- El registro de admins está cerrado ("Allow new users to sign up" = OFF); solo el dueño del proyecto Supabase puede crear cuentas de admin (ver "Administradores").

## Stack

- React 19 + Vite 8
- Tailwind CSS v4
- @supabase/supabase-js v2 (Realtime `postgres_changes`)
- Vitest + Testing Library
