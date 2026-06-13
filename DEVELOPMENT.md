# Desarrollo y despliegue

Guía técnica para configurar, desarrollar y desplegar ArenaQuiz. Para el manual de uso de la app, ver [README.md](./README.md).

## Requisitos

- Node 22
- Una cuenta de [Supabase](https://supabase.com)

## Setup de Supabase

1. Crea un proyecto en Supabase y ejecuta `supabase/schema.sql` en el SQL Editor (crea las tablas, las políticas RLS y las funciones RPC).
2. **Authentication → Sign In / Providers**:
   - Desactiva **"Allow new users to sign up"** (sección "User Signups"). No hay auto-registro: las cuentas de admin se crean manualmente (ver "Administradores" más abajo).
   - Deja **"Confirm email"** activado (valor por defecto).
3. **Authentication → URL Configuration**: configura **Site URL** y **Redirect URLs** con la URL donde se sirva la app (ver "Despliegue").

## Variables de entorno

```bash
cp .env.example .env
# Rellena VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY (Settings → API)
```

Nunca commitear `.env`.

## Desarrollo local

```bash
npm install
npm run dev
```

## Tests

```bash
npm run test       # corre los tests una vez (Vitest)
npm run test:watch # modo watch
npm run build       # build de producción
```

CI (`.github/workflows/ci.yml`) corre los tests y el build en cada push/PR a `main`.

## Administradores

No hay auto-registro: el toggle "Allow new users to sign up" debe estar desactivado en Supabase (ver "Setup de Supabase"). Para dar acceso de admin a alguien:

1. **Authentication → Users → "Add user"** en el dashboard de Supabase.
2. Introduce su email y una contraseña.
3. Marca **"Auto Confirm User"** para que quede activo de inmediato (sin email de confirmación).

Esa persona ya puede entrar en "Soy Admin" → login con esas credenciales y crear sus propias salas.

## Despliegue (GitHub Pages)

La app se despliega automáticamente a GitHub Pages en cada push a `main` (`.github/workflows/deploy.yml`), usando los secrets del repo `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`.

- `vite.config.js` usa `base: '/ArenaQuiz/'` cuando el workflow define `GITHUB_PAGES=true`.
- En el repo: **Settings → Pages → Source** debe estar en "GitHub Actions".
- En Supabase: añade la URL de Pages en **Authentication → URL Configuration** (Site URL / Redirect URLs) para que los enlaces de confirmación de email redirijan correctamente.

## Seguridad

- RLS está habilitado en las 4 tablas; los participantes (anónimos) solo pueden leer/escribir lo mínimo necesario (ver sección "Autenticación y RLS" en `CLAUDE.md`).
- La pregunta correcta (`correct_answer`) y las respuestas de otros nunca llegan al cliente del participante antes de `showing_results`: se obtienen mediante funciones RPC que filtran esos datos en el servidor.
- El registro de admins está cerrado ("Allow new users to sign up" = OFF); solo el dueño del proyecto Supabase puede crear cuentas de admin (ver "Administradores").

## Stack

- React 19 + Vite 8
- Tailwind CSS v4
- @supabase/supabase-js v2 (Realtime `postgres_changes`)
- Vitest + Testing Library
