import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'

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
    channel: vi.fn(() => createChannel()),
    removeChannel: vi.fn(),
  },
}))

describe('App', () => {
  it('muestra la pantalla de selección de rol al cargar', () => {
    render(<App />)
    expect(screen.getByText('🎯 ArenaQuiz')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Soy Admin' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Soy Participante' })).toBeInTheDocument()
  })

  it('flujo admin: login con token y luego pantalla de crear sala', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Soy Admin' }))
    const tokenInput = screen.getByPlaceholderText('Token (cualquier string)')
    expect(tokenInput).toBeInTheDocument()

    await user.type(tokenInput, 'mi-token')
    await user.click(screen.getByRole('button', { name: 'Entrar' }))

    expect(screen.getByRole('button', { name: 'Crear sala' })).toBeInTheDocument()
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
