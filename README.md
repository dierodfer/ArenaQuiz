<div align="center">

<img src="docs/logo.svg" alt="ArenaQuiz" width="96" height="96">

# arena**quiz**

[![Build Status](https://img.shields.io/github/actions/workflow/status/dierodfer/ArenaQuiz/ci.yml?branch=main&style=for-the-badge)](https://github.com/dierodfer/ArenaQuiz/actions)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)
[![React](https://img.shields.io/badge/react-19-61dafb?style=for-the-badge&logo=react)](https://react.dev)
[![Supabase](https://img.shields.io/badge/supabase-realtime-3ecf8e?style=for-the-badge&logo=supabase)](https://supabase.com)

App tipo Kahoot para encuestas y quizzes en tiempo real.
Ideal para jugar en grupo desde el movil o el ordenador. Sin instalacion, sin complicaciones.

**[Jugar ahora](https://dierodfer.github.io/ArenaQuiz/)**

</div>

---

## Como jugar

### Como participante

1. Abre [ArenaQuiz](https://dierodfer.github.io/ArenaQuiz/) o el enlace directo que te compartan (con codigo de sala incluido)
2. Pulsa **"Soy Participante"** y escribe tu nombre
3. Si abriste un enlace directo, entraras a esa sala. Si no, elige una sala abierta de la lista
4. Cuando empiece cada pregunta, responde lo mas rapido posible
5. Al final veras el ranking con las puntuaciones de todos

### Como organizador (admin)

> El acceso de admin no es de alta libre. Solicita una cuenta a quien gestiona el proyecto.

1. Pulsa **"Soy Admin"** e inicia sesion con tu email y contrasena
2. Gestiona tu **banco de preguntas**: crea preguntas individuales o importa en lote via JSON, organizadas por categorias
3. **Crea una sala**: elige un nombre, selecciona una categoria y las preguntas que quieras usar, configura el tiempo por pregunta, y opcionalmente sube un logo de sala y una imagen final
4. **Comparte el enlace** (URL con codigo de sala) o el codigo de 6 caracteres con los participantes
5. Abre la sala para que se unan, y cuando esten todos pulsa **"Comenzar"**
6. Gestiona el quiz:
   - Cada pregunta tiene temporizador automatico
   - Al acabar el tiempo se muestran los resultados y porcentaje de acierto
   - **"Siguiente"** avanza a la proxima pregunta
   - **"Finalizar encuesta"** salta al ranking en cualquier momento
7. Al terminar se muestra el ranking final (con mensaje e imagen personalizados si los configuraste)

---

## Caracteristicas

- **En tiempo real** — respuestas instantaneas con sincronizacion via Supabase Realtime
- **Enlace directo** — comparte una URL con el codigo de sala; admin y participantes acceden directamente
- **Banco de preguntas** — crea, edita y reutiliza preguntas organizadas por categorias
- **Importacion JSON** — carga preguntas en lote con un JSON estructurado
- **Branding de sala** — logo personalizado y mensaje/imagen final opcionales
- **Multiplataforma** — funciona en movil, tablet y ordenador
- **Tema claro/oscuro** — se adapta a la preferencia del sistema o se cambia manualmente
- **Seguro** — autenticacion para admins, RLS en todas las tablas, respuestas validadas en servidor

---

## Stack tecnico

- **React 19** + **Vite 8** — app rapida y moderna
- **Tailwind CSS v4** — estilos limpios via `@tailwindcss/vite`
- **Supabase** — auth, base de datos, Realtime y Storage
- **GitHub Pages** — despliegue automatico

---

## Desarrollo local

```bash
# Clonar e instalar
git clone https://github.com/dierodfer/ArenaQuiz.git
cd ArenaQuiz
npm install

# Configurar credenciales de Supabase
cp .env.example .env
# Edita .env con tu VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY

# Ejecutar schema en Supabase SQL Editor
# (ver supabase/schema.sql)

# Desarrollo
npm run dev

# Tests
npm run test

# Build de produccion
npm run build
```

---

## Administradores

No hay auto-registro. Para crear una cuenta de admin:

1. Ve al dashboard de Supabase de tu proyecto
2. **Authentication** > **Users** > **Add user**
3. Introduce email y contrasena, marca **"Auto Confirm User"**

---

## Licencia

Este proyecto esta bajo licencia MIT. Ver [LICENSE](LICENSE) para mas detalles.
