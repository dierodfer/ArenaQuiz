import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App, { readRoomHash, saveSession, loadSession, clearSession } from './App'
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
  builder.delete = vi.fn(chain)
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
  location.hash = ''
  sessionStorage.clear()
})

afterEach(() => {
  location.hash = ''
  sessionStorage.clear()
})

describe('App', () => {
  it('muestra la pantalla de selección de rol al cargar', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'ArenaQuiz', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Soy Admin' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Soy Participante' })).toBeInTheDocument()
  })

  it('flujo admin sin sesión: muestra solo el login (sin auto-registro)', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Soy Admin' }))

    expect(await screen.findByPlaceholderText('Email')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Contraseña')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Crear cuenta' })).not.toBeInTheDocument()
  })

  it('flujo admin con sesión activa: muestra el menú (crear sala / banco / salir)', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { user: { id: 'admin-uid', email: 'admin@example.com' } } },
    })

    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Soy Admin' }))

    expect(await screen.findByRole('button', { name: 'Crear sala' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Banco de preguntas' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument()
    expect(screen.getByText('admin@example.com')).toBeInTheDocument()
  })

  it('flujo admin: desde el menú se navega al banco de preguntas', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { user: { id: 'admin-uid', email: 'admin@example.com' } } },
    })

    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Soy Admin' }))
    await user.click(await screen.findByRole('button', { name: 'Banco de preguntas' }))

    expect(await screen.findByText('Banco de preguntas')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Categoría (p.ej. Historia)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Guardar pregunta' })).toBeInTheDocument()
  })

  it('flujo participante: muestra el formulario para unirse a una sala', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Soy Participante' }))

    expect(screen.getByText('Unirse a una sala')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Tu nombre')).toBeInTheDocument()
    expect(screen.getByText('Elige una sala:')).toBeInTheDocument()
  })

  it('con hash de sala válido: muestra selector de rol con código de sala', () => {
    location.hash = '#ABC123'
    render(<App />)
    expect(screen.getByText('Sala detectada: ABC123')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Soy Admin' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Soy Participante' })).toBeInTheDocument()
  })

  it('con hash válido + clic en participante: va al formulario de unirse sin lista', async () => {
    location.hash = '#ABC123'
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Soy Participante' }))
    expect(screen.getByText('Unirse a una sala')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Tu nombre')).toBeInTheDocument()
    expect(screen.queryByText('Elige una sala:')).not.toBeInTheDocument()
  })

  it('con hash inválido: muestra la selección de rol normal', () => {
    location.hash = '#bad'
    render(<App />)
    expect(screen.getByRole('button', { name: 'Soy Admin' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Soy Participante' })).toBeInTheDocument()
    expect(screen.queryByText(/Sala detectada/)).not.toBeInTheDocument()
  })

  it('admin con hash y sesión activa: pasa el código de sala al flujo admin', async () => {
    location.hash = '#ABC123'
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { user: { id: 'admin-uid', email: 'admin@example.com' } } },
    })

    const user = userEvent.setup()
    render(<App />)

    expect(screen.getByText('Sala detectada: ABC123')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Soy Admin' }))

    expect(await screen.findByText('admin@example.com')).toBeInTheDocument()
  })
})

describe('readRoomHash', () => {
  afterEach(() => { location.hash = '' })

  it('lee un código válido de 6 caracteres del hash', () => {
    location.hash = '#ABC123'
    expect(readRoomHash()).toBe('ABC123')
  })

  it('convierte a mayúsculas', () => {
    location.hash = '#abc123'
    expect(readRoomHash()).toBe('ABC123')
  })

  it('devuelve null si el hash no es un código válido', () => {
    location.hash = '#too-long-code'
    expect(readRoomHash()).toBeNull()
    location.hash = ''
    expect(readRoomHash()).toBeNull()
    location.hash = '#AB'
    expect(readRoomHash()).toBeNull()
  })
})

describe('session helpers', () => {
  afterEach(() => sessionStorage.clear())

  it('saveSession / loadSession round-trip', () => {
    saveSession('ROOM01', 'participant-uuid')
    const s = loadSession()
    expect(s).toEqual({ roomId: 'ROOM01', participantId: 'participant-uuid' })
  })

  it('loadSession devuelve null sin sesión guardada', () => {
    expect(loadSession()).toBeNull()
  })

  it('clearSession limpia la sesión', () => {
    saveSession('ROOM01', 'p-id')
    clearSession()
    expect(loadSession()).toBeNull()
  })
})
