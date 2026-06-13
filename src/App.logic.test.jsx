import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { generateRoomCode, useQuestionTimer, validateUsername } from './App'

// App.jsx importa supabaseClient a nivel de módulo; lo mockeamos para que
// createClient no falle al no haber credenciales reales en el entorno de test.
vi.mock('./supabaseClient', () => ({ supabase: {} }))

describe('generateRoomCode', () => {
  it('genera un código de 6 caracteres dentro del charset permitido', () => {
    const code = generateRoomCode()
    expect(code).toHaveLength(6)
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
  })

  it('genera códigos distintos entre llamadas', () => {
    const codes = new Set(Array.from({ length: 30 }, () => generateRoomCode()))
    expect(codes.size).toBeGreaterThan(1)
  })
})

describe('validateUsername', () => {
  it('rechaza nombres con menos de 3 caracteres', () => {
    expect(validateUsername('ab')).toBeTruthy()
    expect(validateUsername('  a ')).toBeTruthy()
    expect(validateUsername('')).toBeTruthy()
  })

  it('acepta nombres de 3 o más caracteres', () => {
    expect(validateUsername('ana')).toBeNull()
    expect(validateUsername('  Pedro ')).toBeNull()
  })
})

describe('useQuestionTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('se queda en idle cuando la sala no está in_question', () => {
    const { result } = renderHook(() =>
      useQuestionTimer({ status: 'open', current_question_index: 0, time_per_question: 15 }, vi.fn()),
    )
    expect(result.current.phase).toBe('idle')
    expect(result.current.timeLeft).toBe(0)
  })

  it('empieza en fase "reading" y pasa a "answering" tras 3s con el tiempo completo', () => {
    const onTimeUp = vi.fn()
    const { result } = renderHook(() =>
      useQuestionTimer({ status: 'in_question', current_question_index: 0, time_per_question: 5 }, onTimeUp),
    )

    expect(result.current.phase).toBe('reading')
    expect(result.current.timeLeft).toBe(5)

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(result.current.phase).toBe('answering')
    expect(result.current.timeLeft).toBe(5)
    expect(onTimeUp).not.toHaveBeenCalled()
  })

  it('cuenta hacia atrás cada segundo y llama a onTimeUp en cuanto llega a 0', () => {
    const onTimeUp = vi.fn()
    const { result } = renderHook(() =>
      useQuestionTimer({ status: 'in_question', current_question_index: 0, time_per_question: 2 }, onTimeUp),
    )

    act(() => {
      vi.advanceTimersByTime(3000) // fin de la fase "reading"
    })
    expect(result.current.timeLeft).toBe(2)

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.timeLeft).toBe(1)
    expect(onTimeUp).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current.timeLeft).toBe(0)
    expect(onTimeUp).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(onTimeUp).toHaveBeenCalledTimes(1) // no vuelve a disparar
  })

  it('reinicia a fase "reading" con el tiempo completo cuando cambia current_question_index', () => {
    const onTimeUp = vi.fn()
    const { result, rerender } = renderHook(
      ({ room }) => useQuestionTimer(room, onTimeUp),
      {
        initialProps: {
          room: { status: 'in_question', current_question_index: 0, time_per_question: 5 },
        },
      },
    )

    act(() => {
      vi.advanceTimersByTime(3000) // reading -> answering, timeLeft sigue en 5
    })
    act(() => {
      vi.advanceTimersByTime(1000) // timeLeft: 5 -> 4
    })
    act(() => {
      vi.advanceTimersByTime(1000) // timeLeft: 4 -> 3
    })
    expect(result.current.phase).toBe('answering')
    expect(result.current.timeLeft).toBe(3)

    rerender({ room: { status: 'in_question', current_question_index: 1, time_per_question: 5 } })

    expect(result.current.phase).toBe('reading')
    expect(result.current.timeLeft).toBe(5)
  })
})
