import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  generateRoomCode,
  useQuestionTimer,
  validateUsername,
  validateEmail,
  validateRoomName,
  formatRelativeTime,
} from './App'

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

  it('rechaza palabras ofensivas (es) ignorando mayúsculas, acentos y dígitos', () => {
    expect(validateUsername('puta')).toBeTruthy()
    expect(validateUsername('Mierda')).toBeTruthy()
    expect(validateUsername('puta69')).toBeTruthy()
    expect(validateUsername('soy puta')).toBeTruthy()
  })

  it('no bloquea nombres legítimos que contienen una mala palabra como subcadena', () => {
    expect(validateUsername('Mariano')).toBeNull()
    expect(validateUsername('Calculo')).toBeNull()
  })

  it('rechaza nombres de más de 10 caracteres', () => {
    expect(validateUsername('Maximiliano')).toBeTruthy() // 11
    expect(validateUsername('abcdefghij')).toBeNull() // 10, límite exacto
  })
})

describe('validateEmail', () => {
  it('acepta vacío (es opcional)', () => {
    expect(validateEmail('')).toBeNull()
    expect(validateEmail('   ')).toBeNull()
  })

  it('acepta emails con formato válido', () => {
    expect(validateEmail('ana@example.com')).toBeNull()
    expect(validateEmail('  pedro.lopez@correo.es ')).toBeNull()
  })

  it('rechaza formatos inválidos', () => {
    expect(validateEmail('no-es-un-email')).toBeTruthy()
    expect(validateEmail('falta@dominio')).toBeTruthy()
    expect(validateEmail('@sinnombre.com')).toBeTruthy()
  })

  it('rechaza emails de más de 50 caracteres', () => {
    expect(validateEmail(`${'a'.repeat(45)}@b.com`)).toBeTruthy() // 51
  })
})

describe('validateRoomName', () => {
  it('rechaza nombres vacíos', () => {
    expect(validateRoomName('')).toBeTruthy()
    expect(validateRoomName('   ')).toBeTruthy()
  })

  it('acepta nombres no vacíos de hasta 25 caracteres', () => {
    expect(validateRoomName('Trivia de empresa')).toBeNull()
    expect(validateRoomName('a'.repeat(25))).toBeNull()
  })

  it('rechaza nombres de más de 25 caracteres', () => {
    expect(validateRoomName('a'.repeat(26))).toBeTruthy()
  })
})

describe('formatRelativeTime', () => {
  const now = new Date('2026-06-14T10:00:00Z').getTime()
  const minsAgo = (m) => new Date(now - m * 60000).toISOString()

  it('muestra "<1 min" para menos de un minuto', () => {
    expect(formatRelativeTime(minsAgo(0), now)).toBe('hace <1 min')
  })

  it('muestra los minutos transcurridos', () => {
    expect(formatRelativeTime(minsAgo(3), now)).toBe('hace 3 min')
    expect(formatRelativeTime(minsAgo(59), now)).toBe('hace 59 min')
  })

  it('pasa a horas a partir de 60 min', () => {
    expect(formatRelativeTime(minsAgo(60), now)).toBe('hace 1 h')
    expect(formatRelativeTime(minsAgo(150), now)).toBe('hace 2 h')
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
