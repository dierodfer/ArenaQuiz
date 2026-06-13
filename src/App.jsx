import { useState, useEffect, useRef } from 'react'
import { supabase } from './supabaseClient'
// Listas públicas de palabras ofensivas (paquete `naughty-words`). Viven en
// node_modules, no en este repo. Importamos solo es+en para no inflar el bundle.
import esBadWords from 'naughty-words/es.json'
import enBadWords from 'naughty-words/en.json'

const READ_SECONDS = 3
const LETTERS = ['A', 'B', 'C', 'D']
const LETTER_COLORS = {
  A: 'bg-red-600 hover:bg-red-500',
  B: 'bg-blue-600 hover:bg-blue-500',
  C: 'bg-yellow-600 hover:bg-yellow-500',
  D: 'bg-green-600 hover:bg-green-500',
}

export function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

const USERNAME_MIN_LENGTH = 3

// Marcas diacríticas combinantes (acentos) en Unicode, para poder quitarlas.
const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g')

// Minúsculas y sin acentos, para comparar contra la lista negra.
function normalizeForMatch(str) {
  return str.toLowerCase().normalize('NFD').replace(DIACRITICS, '')
}

// Lista negra normalizada (es + en). Solo palabras de 3+ letras para evitar
// falsos positivos triviales.
const USERNAME_BLACKLIST = new Set(
  [...esBadWords, ...enBadWords]
    .map((w) => normalizeForMatch(w).replace(/[^a-z]+/g, ''))
    .filter((w) => w.length >= USERNAME_MIN_LENGTH),
)

// Valida el nombre del participante. Devuelve un mensaje de error o null si es
// válido. Bloquea si el nombre entero (sin separadores) o alguno de sus tokens
// coincide exactamente con una palabra de la lista negra; el match exacto evita
// bloquear nombres legítimos que contengan una mala palabra (p.ej. "Mariano").
export function validateUsername(name) {
  const trimmed = name.trim()
  if (trimmed.length < USERNAME_MIN_LENGTH) {
    return `El nombre debe tener al menos ${USERNAME_MIN_LENGTH} caracteres.`
  }
  const normalized = normalizeForMatch(trimmed)
  const collapsed = normalized.replace(/[^a-z]+/g, '')
  const tokens = normalized.split(/[^a-z]+/).filter(Boolean)
  if (USERNAME_BLACKLIST.has(collapsed) || tokens.some((t) => USERNAME_BLACKLIST.has(t))) {
    return 'Ese nombre no está permitido. Elige otro.'
  }
  return null
}

// Timer cliente: fase "lea" de 3s sin timer visible, luego cuenta atrás oficial.
// Se reinicia cada vez que la sala entra en in_question o cambia de pregunta.
export function useQuestionTimer(room, onTimeUp) {
  const [phase, setPhase] = useState('idle') // idle | reading | answering
  const [timeLeft, setTimeLeft] = useState(0)
  const firedRef = useRef(false)

  useEffect(() => {
    if (room?.status !== 'in_question') {
      setPhase('idle')
      return
    }
    firedRef.current = false
    setPhase('reading')
    setTimeLeft(room.time_per_question)
    const t = setTimeout(() => setPhase('answering'), READ_SECONDS * 1000)
    return () => clearTimeout(t)
  }, [room?.status, room?.current_question_index])

  useEffect(() => {
    if (phase !== 'answering' || room?.status !== 'in_question') return
    if (timeLeft <= 0) {
      if (!firedRef.current) {
        firedRef.current = true
        onTimeUp?.()
      }
      return
    }
    const t = setTimeout(() => setTimeLeft((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, timeLeft, room?.status])

  return { phase, timeLeft }
}

// Suscripción Realtime a la fila de la sala: todos los clientes reaccionan
// instantáneamente cuando el admin cambia status o current_question_index.
function useRoomSubscription(roomId, setRoom) {
  useEffect(() => {
    if (!roomId) return
    const channel = supabase
      .channel(`room-${roomId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` },
        (payload) => setRoom(payload.new),
      )
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [roomId])
}

// La pregunta actual se obtiene vía RPC: get_current_question oculta
// correct_answer hasta que la sala entra en showing_results (RLS no permite
// a los participantes leer la tabla questions directamente).
function useCurrentQuestion(room) {
  const [question, setQuestion] = useState(null)
  useEffect(() => {
    if (!room || !['in_question', 'showing_results'].includes(room.status)) {
      setQuestion(null)
      return
    }
    supabase
      .rpc('get_current_question', { p_room_id: room.id })
      .then(({ data }) => setQuestion(data?.[0] ?? null))
  }, [room?.id, room?.status, room?.current_question_index])
  return question
}

// % de acierto vía RPC: get_question_stats agrega answers sin exponer las
// respuestas individuales (la tabla answers no es legible por participantes).
function useQuestionStats(room, question) {
  const [stats, setStats] = useState(null)
  useEffect(() => {
    if (room?.status !== 'showing_results' || !question) {
      setStats(null)
      return
    }
    supabase
      .rpc('get_question_stats', { p_question_id: question.id })
      .then(({ data }) => {
        const row = data?.[0]
        const total = row?.total ?? 0
        const correct = row?.correct ?? 0
        setStats({ total, correct, pct: total ? Math.round((correct / total) * 100) : 0 })
      })
  }, [room?.status, question?.id])
  return stats
}

// Barra de progreso del temporizador. Acompaña a la cuenta atrás numérica
// durante la fase "answering"; se vacía a medida que se agota el tiempo.
function TimerBar({ phase, timeLeft, total }) {
  if (phase !== 'answering') return null
  const pct = total ? Math.max(0, Math.min(100, (timeLeft / total) * 100)) : 0
  return (
    <div className="h-2 w-full bg-slate-700 rounded overflow-hidden" aria-hidden="true">
      <div
        className="h-full bg-indigo-500 transition-all duration-1000 ease-linear"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

// Evita copiar/pegar el texto de preguntas y respuestas (deshabilita
// selección y menú contextual) para que no se compartan fácilmente.
function NoCopy({ children, className = '' }) {
  return (
    <span
      className={`select-none ${className}`}
      onCopy={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </span>
  )
}

// Desglose por opción: muestra el texto de cada respuesta posible y, justo
// debajo, el porcentaje y el número de respuestas recibidas. Si showCorrect,
// resalta la opción correcta.
function AnswerBreakdown({ question, answers, showCorrect }) {
  const total = answers.length
  return (
    <div className="space-y-2">
      {question.options.map((opt, i) => {
        const letter = LETTERS[i]
        const count = answers.filter((a) => a.answer === letter).length
        const pct = total ? Math.round((count / total) * 100) : 0
        const isCorrect = showCorrect && question.correct_answer === letter
        return (
          <div
            key={letter}
            className={`rounded p-2 ${isCorrect ? 'bg-slate-800 ring-2 ring-green-400' : 'bg-slate-800'}`}
          >
            <div className="flex justify-between gap-2">
              <span>
                <span className="font-bold">{letter}.</span> <NoCopy>{opt}</NoCopy>
              </span>
              {isCorrect && <span className="text-green-400">✔</span>}
            </div>
            <div className="text-sm text-slate-400">
              {pct}% · {count} {count === 1 ? 'respuesta' : 'respuestas'}
            </div>
            <div className="h-1.5 bg-slate-700 rounded mt-1 overflow-hidden">
              <div className="h-full bg-indigo-500 rounded" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Ranking({ roomId, highlightId }) {
  const [rows, setRows] = useState([])
  useEffect(() => {
    supabase
      .from('participants')
      .select('*')
      .eq('room_id', roomId)
      .order('score', { ascending: false })
      .then(({ data }) => setRows(data ?? []))
  }, [roomId])
  return (
    <div className="space-y-2">
      <h2 className="text-2xl font-bold text-center">🏆 Ranking final</h2>
      {rows.map((p, i) => (
        <div
          key={p.id}
          className={`flex justify-between px-4 py-2 rounded ${
            p.id === highlightId ? 'bg-indigo-600' : 'bg-slate-800'
          }`}
        >
          <span>
            #{i + 1} {p.username} {p.id === highlightId && '(tú)'}
          </span>
          <span className="font-bold">{p.score} pts</span>
        </div>
      ))}
    </div>
  )
}

// ---------- ADMIN ----------

function AdminApp() {
  const [session, setSession] = useState(undefined) // undefined = cargando, null = sin sesión
  const [room, setRoom] = useState(null)
  const [view, setView] = useState('menu') // menu | create | bank

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  if (session === undefined) {
    return (
      <Card title="🎯 ArenaQuiz">
        <p className="text-center text-slate-400">Cargando...</p>
      </Card>
    )
  }

  if (!session) return <AdminAuth />
  if (room) return <AdminRoom room={room} setRoom={setRoom} onExit={() => { setRoom(null); setView('menu') }} />
  if (view === 'create') {
    return <CreateRoom session={session} setRoom={setRoom} onBack={() => setView('menu')} />
  }
  if (view === 'bank') return <QuestionBank session={session} onBack={() => setView('menu')} />
  return <AdminMenu session={session} onCreate={() => setView('create')} onBank={() => setView('bank')} />
}

function AdminAuth() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')

  // No hay auto-registro: las cuentas de admin se crean manualmente desde
  // el dashboard de Supabase (Authentication → Users → Add user).
  const submit = async () => {
    setMessage('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return setMessage(error.message)
  }

  return (
    <Card title="Admin · Iniciar sesión">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <input
          className="input"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="input"
          type="password"
          placeholder="Contraseña"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {message && <p className="text-sm text-amber-400">{message}</p>}
        <button className="btn" type="submit" disabled={!email.trim() || !password.trim()}>
          Entrar
        </button>
      </form>
    </Card>
  )
}

// Menú principal del admin tras iniciar sesión.
function AdminMenu({ session, onCreate, onBank }) {
  return (
    <Card title="🎯 ArenaQuiz · Admin">
      <p className="text-sm text-slate-400 text-center">{session.user.email}</p>
      <button className="btn" onClick={onCreate}>
        Crear sala
      </button>
      <button className="btn bg-purple-600 hover:bg-purple-500" onClick={onBank}>
        Banco de preguntas
      </button>
      <button
        className="btn bg-slate-700 hover:bg-slate-600"
        onClick={() => supabase.auth.signOut()}
      >
        Cerrar sesión
      </button>
    </Card>
  )
}

// Banco de preguntas: las preguntas se crean aquí, independientes de cualquier
// sala, y se etiquetan con una categoría de texto libre. Luego se eligen al
// crear una sala (ver CreateRoom).
function QuestionBank({ session, onBack }) {
  const [questions, setQuestions] = useState([])
  const [title, setTitle] = useState('')
  const [options, setOptions] = useState(['', '', '', ''])
  const [correct, setCorrect] = useState('A')
  const [category, setCategory] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    supabase
      .from('questions')
      .select('*')
      .eq('admin_id', session.user.id)
      .order('category')
      .order('created_at')
      .then(({ data }) => setQuestions(data ?? []))
  }, [])

  const categories = [...new Set(questions.map((q) => q.category))].sort()
  const valid = title.trim() && options.every((o) => o.trim()) && category.trim()

  const addQuestion = async () => {
    setError('')
    if (!valid) return
    const { data, error: insErr } = await supabase
      .from('questions')
      .insert({
        admin_id: session.user.id,
        category: category.trim(),
        title: title.trim(),
        options,
        correct_answer: correct,
      })
      .select()
      .single()
    if (insErr) return setError(insErr.message)
    setQuestions((prev) => [...prev, data])
    setTitle('')
    setOptions(['', '', '', ''])
    setCorrect('A')
  }

  const removeQuestion = async (id) => {
    setError('')
    const { error: delErr } = await supabase.from('questions').delete().eq('id', id)
    if (delErr) return setError(delErr.message)
    setQuestions((prev) => prev.filter((q) => q.id !== id))
  }

  // Agrupadas por categoría para mostrarlas.
  const grouped = categories.map((cat) => ({
    category: cat,
    items: questions.filter((q) => q.category === cat),
  }))

  return (
    <Card title="Banco de preguntas">
      <button className="text-sm text-slate-400 hover:text-slate-200" onClick={onBack}>
        ← Volver
      </button>

      <form
        className="space-y-2 border border-slate-700 rounded p-3"
        onSubmit={(e) => {
          e.preventDefault()
          addQuestion()
        }}
      >
        <h3 className="font-bold">Nueva pregunta</h3>
        <input
          className="input"
          placeholder="Categoría (p.ej. Historia)"
          list="bank-categories"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <datalist id="bank-categories">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <input
          className="input"
          placeholder="Título de la pregunta"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        {LETTERS.map((l, i) => (
          <div key={l} className="flex items-center gap-2">
            <input
              type="radio"
              name="correct"
              checked={correct === l}
              onChange={() => setCorrect(l)}
            />
            <input
              className="input flex-1"
              placeholder={`Opción ${l}`}
              value={options[i]}
              onChange={(e) => setOptions(options.map((o, j) => (j === i ? e.target.value : o)))}
            />
          </div>
        ))}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button className="btn" type="submit" disabled={!valid}>
          Guardar pregunta
        </button>
      </form>

      <div className="space-y-3">
        <h3 className="font-bold">Tus preguntas ({questions.length})</h3>
        {questions.length === 0 && (
          <p className="text-sm text-slate-500">Aún no has creado preguntas.</p>
        )}
        {grouped.map((group) => (
          <div key={group.category} className="space-y-1">
            <p className="text-sm font-semibold text-indigo-300">{group.category}</p>
            {group.items.map((q) => (
              <div
                key={q.id}
                className="flex justify-between items-center gap-2 bg-slate-800 rounded px-3 py-2"
              >
                <span className="text-sm">{q.title}</span>
                <button
                  className="text-sm text-red-400 hover:text-red-300 shrink-0"
                  onClick={() => removeQuestion(q.id)}
                >
                  Eliminar
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Card>
  )
}

// Crear sala: se elige el tiempo por pregunta, una categoría del banco y, dentro
// de ella, las preguntas concretas (el orden de selección define el orden de
// juego). Al crear la sala se insertan las filas de room_questions.
function CreateRoom({ session, setRoom, onBack }) {
  const [timePerQuestion, setTimePerQuestion] = useState(15)
  const [questions, setQuestions] = useState([])
  const [category, setCategory] = useState('')
  const [selectedIds, setSelectedIds] = useState([]) // en orden de selección
  const [error, setError] = useState('')

  useEffect(() => {
    supabase
      .from('questions')
      .select('*')
      .eq('admin_id', session.user.id)
      .order('created_at')
      .then(({ data }) => setQuestions(data ?? []))
  }, [])

  const categories = [...new Set(questions.map((q) => q.category))].sort()
  const inCategory = category ? questions.filter((q) => q.category === category) : []

  const selectCategory = (cat) => {
    setCategory(cat)
    setSelectedIds([])
  }

  const toggle = (id) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const createRoom = async () => {
    setError('')
    if (selectedIds.length === 0) return
    const id = generateRoomCode()
    const { data: r, error: rErr } = await supabase
      .from('rooms')
      .insert({
        id,
        admin_id: session.user.id,
        status: 'waiting',
        current_question_index: 0,
        time_per_question: timePerQuestion,
      })
      .select()
      .single()
    if (rErr) return setError(rErr.message)
    const rows = selectedIds.map((qid, i) => ({
      room_id: id,
      question_id: qid,
      question_number: i,
    }))
    const { error: rqErr } = await supabase.from('room_questions').insert(rows)
    if (rqErr) return setError(rqErr.message)
    setRoom(r)
  }

  return (
    <Card title="Crear sala">
      <button className="text-sm text-slate-400 hover:text-slate-200" onClick={onBack}>
        ← Volver
      </button>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          createRoom()
        }}
      >
        <div>
          <p className="text-sm mb-1">Segundos por pregunta</p>
          <div className="flex gap-2" role="group" aria-label="Segundos por pregunta">
            {[10, 15, 20, 25, 30].map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={timePerQuestion === s}
                onClick={() => setTimePerQuestion(s)}
                className={`flex-1 py-2 rounded font-semibold transition-colors ${
                  timePerQuestion === s
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="text-sm mb-1">Categoría</p>
          {categories.length === 0 ? (
            <p className="text-sm text-amber-400">
              No tienes preguntas en el banco. Crea alguna primero.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Categoría">
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={category === c}
                  onClick={() => selectCategory(c)}
                  className={`px-3 py-1.5 rounded font-semibold transition-colors ${
                    category === c
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>

        {category && (
          <div>
            <p className="text-sm mb-1">
              Preguntas ({selectedIds.length} seleccionadas) — el orden de selección es el orden de
              juego
            </p>
            <div className="space-y-2">
              {inCategory.map((q) => {
                const order = selectedIds.indexOf(q.id)
                const selected = order !== -1
                return (
                  <button
                    key={q.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggle(q.id)}
                    className={`w-full text-left px-3 py-2 rounded transition-colors flex items-center gap-2 ${
                      selected
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
                    }`}
                  >
                    {selected && (
                      <span className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-white text-indigo-700 text-sm font-bold">
                        {order + 1}
                      </span>
                    )}
                    <span className="text-sm">{q.title}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
        <button className="btn" type="submit" disabled={selectedIds.length === 0}>
          Crear sala
        </button>
      </form>
    </Card>
  )
}

function AdminRoom({ room, setRoom, onExit }) {
  const [participants, setParticipants] = useState([])
  const [questions, setQuestions] = useState([])
  const [liveAnswers, setLiveAnswers] = useState([])
  const question = useCurrentQuestion(room)
  const stats = useQuestionStats(room, question)

  useRoomSubscription(room.id, setRoom)

  // Preguntas de la sala (banco filtrado vía room_questions, en orden de juego).
  useEffect(() => {
    supabase
      .from('room_questions')
      .select('question_number, questions(*)')
      .eq('room_id', room.id)
      .order('question_number')
      .then(({ data }) =>
        setQuestions(
          (data ?? []).map((rq) => ({ ...rq.questions, question_number: rq.question_number })),
        ),
      )
  }, [room.id])

  // Participantes en vivo (INSERT mientras la sala está abierta, UPDATE para scores)
  useEffect(() => {
    supabase
      .from('participants')
      .select('*')
      .eq('room_id', room.id)
      .then(({ data }) => setParticipants(data ?? []))
    const channel = supabase
      .channel(`participants-${room.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'participants', filter: `room_id=eq.${room.id}` },
        (payload) => setParticipants((prev) => [...prev, payload.new]),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'participants', filter: `room_id=eq.${room.id}` },
        (payload) =>
          setParticipants((prev) => prev.map((p) => (p.id === payload.new.id ? payload.new : p))),
      )
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [room.id])

  // Limpia las respuestas en vivo solo al cambiar de pregunta (no al pasar de
  // in_question a showing_results, donde queremos conservar el desglose).
  useEffect(() => {
    setLiveAnswers([])
  }, [question?.id])

  // Respuestas en vivo de la pregunta actual (solo el admin lo necesita). Se
  // refresca tanto en in_question como en showing_results para el desglose.
  useEffect(() => {
    if (!question || !['in_question', 'showing_results'].includes(room.status)) return
    let active = true
    supabase
      .from('answers')
      .select('*')
      .eq('question_id', question.id)
      .then(({ data }) => {
        if (active) setLiveAnswers(data ?? [])
      })
    const channel = supabase
      .channel(`answers-${question.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'answers', filter: `question_id=eq.${question.id}` },
        (payload) => setLiveAnswers((prev) => [...prev, payload.new]),
      )
      .subscribe()
    return () => {
      active = false
      supabase.removeChannel(channel)
    }
  }, [question?.id, room.status])

  const updateRoom = async (fields) => {
    const { data, error } = await supabase
      .from('rooms')
      .update(fields)
      .eq('id', room.id)
      .select()
      .single()
    if (error) return alert(error.message)
    setRoom(data)
  }

  // Timer del admin: cuando llega a 0 cierra la pregunta para todos
  const { phase, timeLeft } = useQuestionTimer(room, () =>
    updateRoom({ status: 'showing_results' }),
  )

  const nextQuestion = () => {
    const nextIndex = room.current_question_index + 1
    if (nextIndex < questions.length) {
      updateRoom({ current_question_index: nextIndex, status: 'in_question' })
    } else {
      updateRoom({ status: 'finished' })
    }
  }

  return (
    <Card title={`Sala ${room.id} · ${room.status.toUpperCase()}`}>
      {room.status === 'waiting' && (
        <>
          <p className="text-sm text-slate-400">{questions.length} preguntas seleccionadas</p>
          <ol className="text-sm text-slate-300 list-decimal list-inside">
            {questions.map((q) => (
              <li key={q.id}>{q.title}</li>
            ))}
          </ol>
          <button className="btn" onClick={() => updateRoom({ status: 'open' })}>
            Abrir sala
          </button>
        </>
      )}

      {room.status === 'open' && (
        <>
          <p className="text-sm text-slate-400">{questions.length} preguntas</p>
          <h3 className="font-bold mt-4">Participantes ({participants.length})</h3>
          <ul className="text-sm text-slate-300">
            {participants.map((p) => (
              <li key={p.id}>• {p.username}</li>
            ))}
          </ul>
          {questions.length === 0 && (
            <p className="text-sm text-amber-400">
              La sala no tiene preguntas; no se puede cerrar.
            </p>
          )}
          <button
            className="btn bg-orange-600 hover:bg-orange-500"
            disabled={questions.length === 0}
            onClick={() => updateRoom({ status: 'closed' })}
          >
            Cerrar sala
          </button>
        </>
      )}

      {room.status === 'closed' && (
        <>
          <p>
            {questions.length} preguntas · {participants.length} participantes
          </p>
          <button
            className="btn"
            disabled={questions.length === 0}
            onClick={() => updateRoom({ current_question_index: 0, status: 'in_question' })}
          >
            Comenzar
          </button>
        </>
      )}

      {room.status === 'in_question' && question && (
        <>
          <h3 className="text-xl font-bold">
            Pregunta {room.current_question_index + 1}: <NoCopy>{question.title}</NoCopy>
          </h3>
          {phase === 'reading' && <p className="text-amber-400">📖 Tiempo de lectura...</p>}
          {phase === 'answering' && (
            <>
              <p className="text-3xl font-mono text-center">⏱ {timeLeft}s</p>
              <TimerBar phase={phase} timeLeft={timeLeft} total={room.time_per_question} />
            </>
          )}
          <p>
            Respuestas en vivo: {liveAnswers.length} / {participants.length}
          </p>
          <p className="text-sm text-slate-400">
            El desglose de respuestas se muestra cuando se agote el tiempo.
          </p>
        </>
      )}

      {room.status === 'showing_results' && question && (
        <>
          <h3 className="text-xl font-bold">
            <NoCopy>{question.title}</NoCopy>
          </h3>
          <p className="text-green-400">
            ✔ Correcta: {question.correct_answer} —{' '}
            <NoCopy>{question.options[LETTERS.indexOf(question.correct_answer)]}</NoCopy>
          </p>
          {stats && (
            <p>
              Acierto: {stats.pct}% ({stats.correct}/{stats.total})
            </p>
          )}
          <AnswerBreakdown question={question} answers={liveAnswers} showCorrect={true} />
          <button className="btn" onClick={nextQuestion}>
            {room.current_question_index + 1 < questions.length ? 'Siguiente' : 'Finalizar'}
          </button>
        </>
      )}

      {room.status === 'finished' && (
        <>
          <Ranking roomId={room.id} />
          <button className="btn bg-slate-700 hover:bg-slate-600" onClick={onExit}>
            Volver al menú
          </button>
        </>
      )}
    </Card>
  )
}

// ---------- PARTICIPANTE ----------

function ParticipantApp() {
  const [username, setUsername] = useState('')
  const [participant, setParticipant] = useState(null)
  const [room, setRoom] = useState(null)
  const [selectedRoomId, setSelectedRoomId] = useState(null)
  const [openRooms, setOpenRooms] = useState([])
  const [error, setError] = useState('')

  const loadOpenRooms = () => {
    supabase
      .from('rooms')
      .select('*')
      .eq('status', 'open')
      .then(({ data }) => setOpenRooms(data ?? []))
  }

  useEffect(() => {
    if (participant) return
    loadOpenRooms()
  }, [participant])

  const usernameError = validateUsername(username)
  const canJoin = !usernameError && !!selectedRoomId

  const join = async () => {
    setError('')
    if (!canJoin) return
    const { data: r, error: rErr } = await supabase
      .from('rooms')
      .select('*')
      .eq('id', selectedRoomId)
      .single()
    if (rErr || !r) return setError('Sala no encontrada')
    if (r.status !== 'open') return setError('La sala ya no está abierta')
    const { data: p, error: pErr } = await supabase
      .from('participants')
      .insert({ room_id: r.id, username: username.trim(), score: 0 })
      .select()
      .single()
    if (pErr) return setError(pErr.message)
    setRoom(r)
    setParticipant(p)
  }

  if (participant && room) {
    return <ParticipantRoom room={room} setRoom={setRoom} participant={participant} />
  }

  return (
    <Card title="Unirse a una sala">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          join()
        }}
      >
        <div>
          <input
            className="input"
            placeholder="Tu nombre"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          {username.trim() && usernameError && (
            <p className="text-sm text-amber-400 mt-1">{usernameError}</p>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm text-slate-400">Elige una sala:</p>
            <button
              type="button"
              onClick={loadOpenRooms}
              className="text-sm text-indigo-400 hover:text-indigo-300"
            >
              ↻ Recargar salas
            </button>
          </div>
          {openRooms.length === 0 ? (
            <p className="text-sm text-slate-500">No hay salas abiertas ahora mismo.</p>
          ) : (
            <div className="space-y-2">
              {openRooms.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={selectedRoomId === r.id}
                  onClick={() => setSelectedRoomId(r.id)}
                  className={`w-full px-4 py-2 rounded font-mono tracking-widest transition-colors ${
                    selectedRoomId === r.id
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
                  }`}
                >
                  {r.id}
                </button>
              ))}
            </div>
          )}
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button className="btn" type="submit" disabled={!canJoin}>
          Entrar
        </button>
      </form>
    </Card>
  )
}

function ParticipantRoom({ room, setRoom, participant }) {
  const question = useCurrentQuestion(room)
  const stats = useQuestionStats(room, question)
  const [myAnswer, setMyAnswer] = useState(null)
  const [score, setScore] = useState(participant.score)

  useRoomSubscription(room.id, setRoom)

  // Nueva pregunta → limpiar respuesta anterior
  useEffect(() => {
    setMyAnswer(null)
  }, [room.current_question_index])

  // El participante no cierra la pregunta: cuando su timer llega a 0 solo
  // espera el evento showing_results que dispara el admin.
  const { phase, timeLeft } = useQuestionTimer(room, () => {})

  const answer = async (letter) => {
    if (myAnswer || !question) return
    // El servidor decide si es correcta y actualiza el score (submit_answer);
    // el cliente nunca calcula is_correct ni el nuevo score.
    const { data, error } = await supabase.rpc('submit_answer', {
      p_question_id: question.id,
      p_participant_id: participant.id,
      p_answer: letter,
    })
    if (error) return alert(error.message)
    const result = data?.[0]
    setMyAnswer({ answer: letter, is_correct: result?.is_correct ?? false })
    if (result) setScore(result.new_score)
  }

  const disabled = phase !== 'answering' || timeLeft <= 0 || !!myAnswer

  return (
    <Card title={`Sala ${room.id} · ${participant.username} · ${score} pts`}>
      {['open', 'waiting', 'closed'].includes(room.status) && (
        <p className="text-center text-lg">⏳ Esperando que empiece...</p>
      )}

      {room.status === 'in_question' && question && (
        <>
          <h3 className="text-xl font-bold text-center">
            <NoCopy>{question.title}</NoCopy>
          </h3>
          {phase === 'reading' && <p className="text-center text-amber-400">📖 Lee la pregunta...</p>}
          {phase === 'answering' && (
            <>
              <p className="text-4xl font-mono text-center">{timeLeft}</p>
              <TimerBar phase={phase} timeLeft={timeLeft} total={room.time_per_question} />
            </>
          )}
          <div className="grid grid-cols-2 gap-2">
            {LETTERS.map((l, i) => (
              <button
                key={l}
                disabled={disabled}
                onClick={() => answer(l)}
                className={`p-4 rounded text-white font-bold disabled:opacity-40 ${LETTER_COLORS[l]} ${
                  myAnswer?.answer === l ? 'ring-4 ring-white' : ''
                }`}
              >
                {l}: <NoCopy>{question.options[i]}</NoCopy>
              </button>
            ))}
          </div>
          {myAnswer && <p className="text-center text-slate-300">Respuesta enviada ✔</p>}
        </>
      )}

      {room.status === 'showing_results' && question && (
        <>
          <h3 className="text-xl font-bold text-center">
            <NoCopy>{question.title}</NoCopy>
          </h3>
          {myAnswer ? (
            <p className={`text-center text-2xl ${myAnswer.is_correct ? 'text-green-400' : 'text-red-400'}`}>
              {myAnswer.is_correct ? '🎉 ¡Acertaste!' : '❌ Fallaste'}
            </p>
          ) : (
            <p className="text-center text-slate-400">No respondiste</p>
          )}
          <p className="text-center text-green-400">
            Correcta: {question.correct_answer} —{' '}
            <NoCopy>{question.options[LETTERS.indexOf(question.correct_answer)]}</NoCopy>
          </p>
          {stats && (
            <p className="text-center">
              Acierto del grupo: {stats.pct}% ({stats.correct}/{stats.total})
            </p>
          )}
          <p className="text-center text-slate-400">Esperando la siguiente pregunta...</p>
        </>
      )}

      {room.status === 'finished' && <Ranking roomId={room.id} highlightId={participant.id} />}
    </Card>
  )
}

// ---------- SHELL ----------

function Card({ title, children }) {
  return (
    <div className="max-w-lg mx-auto mt-8 p-6 bg-slate-800/60 rounded-xl space-y-3">
      <h1 className="text-2xl font-bold text-center">{title}</h1>
      {children}
    </div>
  )
}

export default function App() {
  const [role, setRole] = useState(null)

  if (!role) {
    return (
      <Card title="🎯 ArenaQuiz">
        <button className="btn" onClick={() => setRole('admin')}>
          Soy Admin
        </button>
        <button className="btn bg-purple-600 hover:bg-purple-500" onClick={() => setRole('participant')}>
          Soy Participante
        </button>
      </Card>
    )
  }

  return role === 'admin' ? <AdminApp /> : <ParticipantApp />
}
