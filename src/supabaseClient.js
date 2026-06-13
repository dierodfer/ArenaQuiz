import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// main.jsx usa este flag para mostrar un mensaje en lugar de una página en
// blanco cuando faltan las credenciales (p.ej. un build sin los secrets).
export const hasSupabaseCredentials = Boolean(supabaseUrl && supabaseAnonKey)

if (!hasSupabaseCredentials) {
  console.error(
    'Faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copia .env.example a .env y rellena tus credenciales.',
  )
}

// Placeholders si faltan credenciales para que el import no reviente
// (createClient lanza si la key es vacía); la app no se monta en ese caso.
export const supabase = createClient(
  supabaseUrl || 'http://localhost',
  supabaseAnonKey || 'missing-anon-key',
)
