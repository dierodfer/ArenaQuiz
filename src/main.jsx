import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { hasSupabaseCredentials } from './supabaseClient.js'
import './index.css'

const root = document.getElementById('root')

if (!hasSupabaseCredentials) {
  // Sin credenciales la app no puede funcionar; mostramos un aviso claro en
  // vez de una página en blanco con un error críptico en la consola.
  root.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;text-align:center">
      <div style="max-width:32rem">
        <h1 style="font-size:1.5rem;font-weight:700;margin-bottom:.75rem">⚠️ Configuración incompleta</h1>
        <p style="color:#94a3b8;line-height:1.5">
          Faltan las credenciales de Supabase. Si gestionas este sitio, define
          <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> y vuelve a desplegar.
        </p>
      </div>
    </div>
  `
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}
