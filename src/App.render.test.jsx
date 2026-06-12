import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { supabase } from './supabaseClient'

// Query builder encadenable que imita la API thenable de @supabase/supabase-js
// (select().eq().order()... y luego .then(({ data }) => ...)).
function createQueryBuilder(data = []) {
  const builder = {}
  const chain = () => builder
  builder.select = vi.fn(chain)
  builder.eq = vi.fn(chain)
  builder.order = vi.fn(chain)
  builder.single = vi.fn(chain)
  builder.insert = vi.fn(chain)
  builder.update = vi.fn(chain)
  builder.then = (resolve) => Promise.resolve({ data, error: null }).then(resolve)
  return builder
}

function createChannel() {
  const channel = {}
  channel.on = vi.fn(() => channel)
  channel.subscribe = vi.fn(() => channel)
  return channel
}

vi.mock('./supabaseClient', () => ({
  supabase: {
    from: vi.fn(() => createQueryBuilder([])),
    rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
    channel: vi.fn(() => createChannel()),
    removeChannel: vi.fn(),
    auth: {
      getSession: vi.fn(() => Promise.resolve({ data: { session: null } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn(),
    },
  },
}))

beforeEach(() => {
  vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null } })
})

describe('App', () => {
  it('muestra la pantalla de selección de rol al cargar', () => {
    render(<App />)
    expect(screen.getByText('🎯 ArenaQuiz')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Soy Admin' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Soy Participante' })).toBeInTheDocument()
  })

  it('flujo admin sin sesión: muestra el login y permite cambiar a registro', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Soy Admin' }))

    expect(await screen.findByPlaceholderText('Email')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Contraseña')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '¿No tienes cuenta? Crear una' }))
    expect(screen.getByRole('button', { name: 'Crear cuenta' })).toBeInTheDocument()
  })

  it('flujo admin con sesión activa: muestra la pantalla de crear sala', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { user: { id: 'admin-uid', email: 'admin@example.com' } } },
    })

    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Soy Admin' }))

    expect(await screen.findByRole('button', { name: 'Crear sala' })).toBeInTheDocument()
    expect(screen.getByText('admin@example.com')).toBeInTheDocument()
  })

  it('flujo participante: muestra el formulario para unirse a una sala', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Soy Participante' }))

    expect(screen.getByText('Unirse a una sala')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Tu nombre')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Código (6 chars)')).toBeInTheDocument()
  })
})
