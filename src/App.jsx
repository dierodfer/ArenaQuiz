import { useState, useEffect, useRef } from 'react'
import { motion, MotionConfig } from 'framer-motion'
import {
  Sun, Moon, Target, Loader2, LogIn, Mail, Lock, Unlock, Plus, Library, LogOut,
  ArrowLeft, Tag, Trash2, Clock, ListChecks, Users, User, Play, Copy, Check,
  RefreshCw, Trophy, Medal, Crown, CheckCircle2, XCircle, MinusCircle, AlertCircle,
  ChevronRight, Triangle, Diamond, Circle, Square, Eye,
} from 'lucide-react'
import { supabase } from './supabaseClient'
// Listas públicas de palabras ofensivas (paquete `naughty-words`). Viven en
// node_modules, no en este repo. Importamos solo es+en para no inflar el bundle.
import esBadWords from 'naughty-words/es.json'
import enBadWords from 'naughty-words/en.json'

const READ_SECONDS = 3
const LETTERS = ['A', 'B', 'C', 'D']

// Cada respuesta se identifica por letra + color + forma (icono). La forma evita
// depender solo del color (accesible para daltónicos) y mejora la lectura en
// proyector. Los 4 colores saturados son una excepción deliberada al resto de
// la paleta neutra: solo se usan aquí, donde el código de color aporta señal.
const LETTER_META = {
  A: { Icon: Triangle, solid: 'bg-rose-500', hover: 'hover:bg-rose-600', bar: 'bg-rose-500' },
  B: { Icon: Diamond, solid: 'bg-sky-500', hover: 'hover:bg-sky-600', bar: 'bg-sky-500' },
  C: { Icon: Circle, solid: 'bg-amber-500', hover: 'hover:bg-amber-600', bar: 'bg-amber-500' },
  D: { Icon: Square, solid: 'bg-emerald-500', hover: 'hover:bg-emerald-600', bar: 'bg-emerald-500' },
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

// Tema claro/oscuro persistido en localStorage. La clase inicial la pone un
// script inline en index.html (sin parpadeo); aquí solo la sincronizamos.
function useTheme() {
  const [theme, setTheme] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light',
  )
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    try {
      localStorage.setItem('aq-theme', theme)
    } catch {
      /* almacenamiento no disponible */
    }
  }, [theme])
  return [theme, setTheme]
}

// ---------- PRIMITIVAS DE UI ----------

const enter = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } }
const enterTransition = { duration: 0.25, ease: [0.22, 1, 0.36, 1] }
const listStagger = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } }
const listItem = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }

function Stage({ wide, children }) {
  return <div className={`mx-auto w-full ${wide ? 'max-w-3xl' : 'max-w-md'}`}>{children}</div>
}

function Panel({ children, className = '' }) {
  return (
    <div
      className={`rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${className}`}
    >
      {children}
    </div>
  )
}

function ScreenHeader({ icon: Icon, title, subtitle, right }) {
  return (
    <div className="flex items-start gap-3">
      {Icon && (
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
      )}
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {subtitle && <p className="text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
      </div>
      {right && <div className="ml-auto shrink-0">{right}</div>}
    </div>
  )
}

function BackButton({ onClick }) {
  return (
    <button type="button" onClick={onClick} className="btn-ghost -ml-2 mb-2">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Volver
    </button>
  )
}

function ThemeToggle({ theme, setTheme }) {
  const isDark = theme === 'dark'
  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label={isDark ? 'Activar tema claro' : 'Activar tema oscuro'}
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-600 transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      {isDark ? <Sun className="h-4.5 w-4.5" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
    </button>
  )
}

// Clases compartidas para botones de selección única (tabs/chips/tiles).
function selectClasses(active) {
  return `min-h-11 rounded-lg border px-3 py-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-50 dark:focus-visible:ring-offset-zinc-950 ${
    active
      ? 'border-indigo-600 bg-indigo-600 text-white'
      : 'border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-700'
  }`
}

function Stat({ icon: Icon, value, label }) {
  return (
    <div className="flex flex-col items-center">
      <span className="flex items-center gap-1.5 text-3xl font-bold tabular-nums">
        <Icon className="h-5 w-5 text-zinc-400" aria-hidden="true" />
        {value}
      </span>
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
    </div>
  )
}

function StatusBadge({ status }) {
  const meta = {
    waiting: { label: 'Preparada', dot: 'bg-zinc-400' },
    open: { label: 'Abierta', dot: 'bg-emerald-500' },
    closed: { label: 'Cerrada', dot: 'bg-amber-500' },
    in_question: { label: 'En pregunta', dot: 'bg-indigo-500' },
    showing_results: { label: 'Resultados', dot: 'bg-indigo-500' },
    finished: { label: 'Finalizada', dot: 'bg-zinc-400' },
  }[status] ?? { label: status, dot: 'bg-zinc-400' }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  )
}

// Código PIN de la sala, protagonista del lobby y pensado para proyección.
function RoomCode({ code }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* portapapeles no disponible */
    }
  }
  return (
    <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-6 text-center dark:border-zinc-800 dark:bg-zinc-900/50">
      <p className="text-xs font-medium uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
        Código de sala
      </p>
      <p className="mt-2 font-mono text-5xl font-bold tracking-[0.15em] text-zinc-900 sm:text-7xl dark:text-white">
        {code}
      </p>
      <button type="button" onClick={copy} className="btn-ghost mx-auto mt-3">
        {copied ? <Check className="h-4 w-4 text-emerald-500" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
        {copied ? 'Copiado' : 'Copiar código'}
      </button>
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

// Barra de progreso del temporizador. Acompaña a la cuenta atrás numérica
// durante la fase "answering"; se vacía a medida que se agota el tiempo.
function TimerBar({ phase, timeLeft, total }) {
  if (phase !== 'answering') return null
  const pct = total ? Math.max(0, Math.min(100, (timeLeft / total) * 100)) : 0
  const low = timeLeft <= 5
  return (
    <div className="mx-auto h-2 w-full max-w-md overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" aria-hidden="true">
      <div
        className={`h-full rounded-full transition-all duration-1000 ease-linear ${low ? 'bg-rose-500' : 'bg-indigo-500'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

// Desglose por opción: muestra el texto de cada respuesta posible y, justo
// debajo, el porcentaje y el número de respuestas recibidas. Si showCorrect,
// resalta la opción correcta.
function AnswerBreakdown({ question, answers, showCorrect }) {
  const total = answers.length
  return (
    <div className="space-y-2.5">
      {question.options.map((opt, i) => {
        const letter = LETTERS[i]
        const { Icon, bar } = LETTER_META[letter]
        const count = answers.filter((a) => a.answer === letter).length
        const pct = total ? Math.round((count / total) * 100) : 0
        const isCorrect = showCorrect && question.correct_answer === letter
        return (
          <div
            key={letter}
            className={`rounded-xl border p-3 ${
              isCorrect
                ? 'border-emerald-500/60 bg-emerald-50 dark:bg-emerald-500/10'
                : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900'
            }`}
          >
            <div className="flex items-center gap-3">
              <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white ${bar}`}>
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 font-medium">
                <span className="mr-1 text-zinc-400">{letter}.</span>
                <NoCopy>{opt}</NoCopy>
              </span>
              {isCorrect && <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" aria-hidden="true" />}
              <span className="shrink-0 tabular-nums text-sm text-zinc-500 dark:text-zinc-400">
                {pct}% · {count}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div className={`h-full rounded-full ${isCorrect ? 'bg-emerald-500' : bar}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------- RANKING ----------

function Podium({ top, highlightId }) {
  const medal = ['text-amber-400', 'text-zinc-400', 'text-amber-600']
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {top.map((p, i) => (
        <motion.div
          key={p.id}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.08, duration: 0.3, ease: 'easeOut' }}
          className={`relative rounded-2xl border p-4 text-center ${
            i === 0 ? 'sm:-mt-2' : ''
          } ${
            p.id === highlightId
              ? 'border-indigo-500/60 bg-indigo-50 dark:bg-indigo-500/10'
              : i === 0
                ? 'border-amber-300/60 bg-gradient-to-b from-amber-50 to-white dark:border-amber-500/30 dark:from-amber-500/10 dark:to-zinc-900'
                : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900'
          }`}
        >
          <div className="mx-auto mb-1 flex h-9 items-center justify-center">
            {i === 0 ? (
              <Crown className="h-7 w-7 text-amber-400" aria-hidden="true" />
            ) : (
              <Medal className={`h-6 w-6 ${medal[i]}`} aria-hidden="true" />
            )}
          </div>
          <p className="truncate font-semibold">
            {p.username} {p.id === highlightId && <span className="text-indigo-500">· tú</span>}
          </p>
          <p className="text-2xl font-bold tabular-nums">{p.score}</p>
          <p className="text-xs text-zinc-400">pts · #{i + 1}</p>
        </motion.div>
      ))}
    </div>
  )
}

function RankRow({ rank, p, highlight }) {
  return (
    <li
      className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
        highlight
          ? 'border-indigo-500/60 bg-indigo-50 dark:bg-indigo-500/10'
          : 'border-transparent bg-zinc-50 dark:bg-zinc-900/60'
      }`}
    >
      <span className="w-6 text-center text-sm font-semibold tabular-nums text-zinc-400">{rank}</span>
      <span className="min-w-0 flex-1 truncate font-medium">
        {p.username}
        {highlight && <span className="ml-1 text-xs text-indigo-500">(tú)</span>}
      </span>
      <span className="tabular-nums font-semibold">{p.score}</span>
      <span className="text-xs text-zinc-400">pts</span>
    </li>
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

  // Solo animamos el podio (≤3 elementos); el resto se renderiza como lista
  // plana para no lanzar cientos de animaciones con muchos participantes.
  const top = rows.slice(0, 3)
  const rest = rows.slice(3)

  return (
    <div className="space-y-6">
      <div className="text-center">
        <span className="mx-auto mb-2 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-500 dark:bg-amber-500/10">
          <Trophy className="h-6 w-6" aria-hidden="true" />
        </span>
        <h2 className="text-2xl font-bold tracking-tight">Ranking final</h2>
      </div>
      {rows.length === 0 ? (
        <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">Sin participantes.</p>
      ) : (
        <>
          <Podium top={top} highlightId={highlightId} />
          {rest.length > 0 && (
            <ol className="space-y-1.5">
              {rest.map((p, i) => (
                <RankRow key={p.id} rank={i + 4} p={p} highlight={p.id === highlightId} />
              ))}
            </ol>
          )}
        </>
      )}
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
      <Stage>
        <div className="flex flex-col items-center gap-3 py-16 text-zinc-500 dark:text-zinc-400">
          <Loader2 className="h-7 w-7 animate-spin text-indigo-500" aria-hidden="true" />
          <p>Cargando…</p>
        </div>
      </Stage>
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
    <Stage>
      <motion.div initial={enter.initial} animate={enter.animate} transition={enterTransition}>
        <Panel className="space-y-6 p-6 sm:p-8">
          <ScreenHeader icon={Lock} title="Iniciar sesión" subtitle="Acceso de administrador" />
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <div>
              <label htmlFor="admin-email" className="mb-1.5 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Email
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
                <input
                  id="admin-email"
                  className="input pl-9"
                  type="email"
                  placeholder="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </div>
            <div>
              <label htmlFor="admin-pass" className="mb-1.5 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Contraseña
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
                <input
                  id="admin-pass"
                  className="input pl-9"
                  type="password"
                  placeholder="Contraseña"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </div>
            {message && (
              <p className="flex items-center gap-1.5 text-sm text-rose-600 dark:text-rose-400">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {message}
              </p>
            )}
            <button className="btn" type="submit" disabled={!email.trim() || !password.trim()}>
              <LogIn className="h-4 w-4" aria-hidden="true" />
              Entrar
            </button>
          </form>
        </Panel>
      </motion.div>
    </Stage>
  )
}

// Botón-tarjeta usado en selección de rol y menú de admin.
function MenuCard({ icon: Icon, title, desc, onClick, accent }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      className="group flex min-h-16 items-center gap-4 rounded-xl border border-zinc-200 bg-white p-4 text-left transition-all hover:border-indigo-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-500"
    >
      <span
        className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${
          accent ? 'bg-indigo-600 text-white' : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200'
        }`}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block font-semibold">{title}</span>
        <span className="block text-sm text-zinc-500 dark:text-zinc-400">{desc}</span>
      </span>
      <ChevronRight className="ml-auto h-5 w-5 shrink-0 text-zinc-300 transition-colors group-hover:text-indigo-500 dark:text-zinc-600" aria-hidden="true" />
    </button>
  )
}

// Menú principal del admin tras iniciar sesión.
function AdminMenu({ session, onCreate, onBank }) {
  return (
    <Stage>
      <motion.div initial={enter.initial} animate={enter.animate} transition={enterTransition}>
        <Panel className="space-y-6 p-6 sm:p-8">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400">
              <Users className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="font-semibold tracking-tight">Panel de administración</h2>
              <p className="truncate text-sm text-zinc-500 dark:text-zinc-400">{session.user.email}</p>
            </div>
          </div>
          <div className="grid gap-3">
            <MenuCard icon={Plus} title="Crear sala" desc="Configura tiempo y elige preguntas" onClick={onCreate} accent />
            <MenuCard icon={Library} title="Banco de preguntas" desc="Crea y organiza por categoría" onClick={onBank} />
          </div>
          <button className="btn-secondary" onClick={() => supabase.auth.signOut()}>
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Cerrar sesión
          </button>
        </Panel>
      </motion.div>
    </Stage>
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
    <Stage>
      <motion.div initial={enter.initial} animate={enter.animate} transition={enterTransition} className="space-y-4">
        <BackButton onClick={onBack} />
        <Panel className="space-y-5 p-6 sm:p-8">
          <ScreenHeader icon={Library} title="Banco de preguntas" subtitle="Reutilizables en cualquier sala" />

          <form
            className="space-y-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/50"
            onSubmit={(e) => {
              e.preventDefault()
              addQuestion()
            }}
          >
            <p className="text-sm font-semibold">Nueva pregunta</p>
            <div className="relative">
              <Tag className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
              <input
                className="input pl-9"
                placeholder="Categoría (p.ej. Historia)"
                list="bank-categories"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </div>
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
            <p className="pt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Marca la opción correcta con el botón de la izquierda.
            </p>
            {LETTERS.map((l, i) => {
              const isC = correct === l
              return (
                <div key={l} className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-pressed={isC}
                    aria-label={`Marcar opción ${l} como correcta`}
                    onClick={() => setCorrect(l)}
                    className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                      isC
                        ? 'border-emerald-500 bg-emerald-500 text-white'
                        : 'border-zinc-300 text-zinc-500 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400'
                    }`}
                  >
                    {isC ? <Check className="h-4 w-4" aria-hidden="true" /> : l}
                  </button>
                  <input
                    className="input"
                    placeholder={`Opción ${l}`}
                    value={options[i]}
                    onChange={(e) => setOptions(options.map((o, j) => (j === i ? e.target.value : o)))}
                  />
                </div>
              )
            })}
            {error && (
              <p className="flex items-center gap-1.5 text-sm text-rose-600 dark:text-rose-400">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {error}
              </p>
            )}
            <button className="btn" type="submit" disabled={!valid}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Guardar pregunta
            </button>
          </form>

          <div className="space-y-3">
            <p className="text-sm font-semibold">Tus preguntas ({questions.length})</p>
            {questions.length === 0 && (
              <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                Aún no has creado preguntas.
              </div>
            )}
            {grouped.map((group) => (
              <div key={group.category} className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-500 dark:text-zinc-400">
                  <Tag className="h-3.5 w-3.5" aria-hidden="true" />
                  {group.category}
                </div>
                {group.items.map((q) => (
                  <div
                    key={q.id}
                    className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">{q.title}</span>
                    <button
                      type="button"
                      aria-label={`Eliminar pregunta: ${q.title}`}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-rose-50 hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 dark:hover:bg-rose-500/10"
                      onClick={() => removeQuestion(q.id)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Panel>
      </motion.div>
    </Stage>
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
    <Stage>
      <motion.div initial={enter.initial} animate={enter.animate} transition={enterTransition} className="space-y-4">
        <BackButton onClick={onBack} />
        <Panel className="space-y-6 p-6 sm:p-8">
          <ScreenHeader icon={Plus} title="Crear sala" subtitle="Configura el tiempo y elige las preguntas" />
          <form
            className="space-y-6"
            onSubmit={(e) => {
              e.preventDefault()
              createRoom()
            }}
          >
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                <Clock className="h-4 w-4 text-zinc-400" aria-hidden="true" />
                Segundos por pregunta
              </p>
              <div className="grid grid-cols-5 gap-2" role="group" aria-label="Segundos por pregunta">
                {[10, 15, 20, 25, 30].map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={timePerQuestion === s}
                    onClick={() => setTimePerQuestion(s)}
                    className={selectClasses(timePerQuestion === s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                <Tag className="h-4 w-4 text-zinc-400" aria-hidden="true" />
                Categoría
              </p>
              {categories.length === 0 ? (
                <div className="rounded-xl border border-dashed border-amber-400/60 bg-amber-50 p-4 text-sm text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                  No tienes preguntas en el banco. Crea alguna primero.
                </div>
              ) : (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Categoría">
                  {categories.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-pressed={category === c}
                      onClick={() => selectCategory(c)}
                      className={selectClasses(category === c)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {category && (
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  <ListChecks className="h-4 w-4 text-zinc-400" aria-hidden="true" />
                  Preguntas
                  <span className="font-normal text-zinc-400">· {selectedIds.length} seleccionadas (el orden es el de juego)</span>
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
                        className={`flex w-full items-center gap-3 text-left ${selectClasses(selected)}`}
                      >
                        <span
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                            selected ? 'bg-white text-indigo-700' : 'border border-zinc-300 text-zinc-400 dark:border-zinc-700'
                          }`}
                        >
                          {selected ? order + 1 : ''}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{q.title}</span>
                        {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {error && (
              <p className="flex items-center gap-1.5 text-sm text-rose-600 dark:text-rose-400">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {error}
              </p>
            )}
            <button className="btn" type="submit" disabled={selectedIds.length === 0}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Crear sala
            </button>
          </form>
        </Panel>
      </motion.div>
    </Stage>
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

  const answeredPct = participants.length
    ? Math.min(100, (liveAnswers.length / participants.length) * 100)
    : 0

  return (
    <Stage wide>
      <motion.div initial={enter.initial} animate={enter.animate} transition={enterTransition}>
        <Panel className="p-6 sm:p-8">
          <div className="flex items-center justify-between gap-3 border-b border-zinc-200 pb-4 dark:border-zinc-800">
            <div className="flex items-baseline gap-2">
              <span className="text-xs font-medium uppercase tracking-widest text-zinc-400">Sala</span>
              <span className="font-mono text-lg font-bold tracking-widest">{room.id}</span>
            </div>
            <StatusBadge status={room.status} />
          </div>

          <motion.div
            key={`${room.status}-${room.current_question_index}`}
            initial={enter.initial}
            animate={enter.animate}
            transition={enterTransition}
            className="pt-6"
          >
            {room.status === 'waiting' && (
              <div className="space-y-5">
                <ScreenHeader
                  icon={ListChecks}
                  title="Sala preparada"
                  subtitle={`${questions.length} ${questions.length === 1 ? 'pregunta' : 'preguntas'} · ${room.time_per_question}s por pregunta`}
                />
                <ol className="space-y-2">
                  {questions.map((q, i) => (
                    <li
                      key={q.id}
                      className="flex items-start gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60"
                    >
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {i + 1}
                      </span>
                      <span className="text-sm">{q.title}</span>
                    </li>
                  ))}
                </ol>
                <div className="mx-auto max-w-sm">
                  <button className="btn" onClick={() => updateRoom({ status: 'open' })}>
                    <Unlock className="h-4 w-4" aria-hidden="true" />
                    Abrir sala
                  </button>
                </div>
              </div>
            )}

            {room.status === 'open' && (
              <div className="space-y-6">
                <RoomCode code={room.id} />
                <div className="flex items-center justify-center gap-2 text-zinc-600 dark:text-zinc-300">
                  <Users className="h-5 w-5 text-zinc-400" aria-hidden="true" />
                  <span className="text-2xl font-bold tabular-nums">{participants.length}</span>
                  <span className="text-sm text-zinc-500 dark:text-zinc-400">
                    {participants.length === 1 ? 'participante' : 'participantes'}
                  </span>
                </div>
                {participants.length > 0 && (
                  <div className="flex flex-wrap justify-center gap-2">
                    {participants.map((p) => (
                      <span
                        key={p.id}
                        className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-sm dark:border-zinc-800 dark:bg-zinc-900"
                      >
                        {p.username}
                      </span>
                    ))}
                  </div>
                )}
                {questions.length === 0 && (
                  <p className="text-center text-sm text-amber-600 dark:text-amber-400">
                    La sala no tiene preguntas; no se puede cerrar.
                  </p>
                )}
                <div className="mx-auto max-w-sm">
                  <button
                    className="btn"
                    disabled={questions.length === 0}
                    onClick={() => updateRoom({ status: 'closed' })}
                  >
                    <Lock className="h-4 w-4" aria-hidden="true" />
                    Cerrar sala
                  </button>
                </div>
              </div>
            )}

            {room.status === 'closed' && (
              <div className="space-y-6 text-center">
                <div>
                  <span className="mx-auto mb-2 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
                    <Lock className="h-6 w-6" aria-hidden="true" />
                  </span>
                  <h3 className="text-lg font-semibold">Sala cerrada</h3>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">Ya no entran nuevos participantes</p>
                </div>
                <div className="flex justify-center gap-8">
                  <Stat icon={ListChecks} value={questions.length} label="preguntas" />
                  <Stat icon={Users} value={participants.length} label="participantes" />
                </div>
                <div className="mx-auto max-w-sm">
                  <button
                    className="btn"
                    disabled={questions.length === 0}
                    onClick={() => updateRoom({ current_question_index: 0, status: 'in_question' })}
                  >
                    <Play className="h-4 w-4" aria-hidden="true" />
                    Comenzar
                  </button>
                </div>
              </div>
            )}

            {room.status === 'in_question' && question && (
              <div className="space-y-6 text-center">
                <p className="text-sm font-medium uppercase tracking-widest text-zinc-400">
                  Pregunta {room.current_question_index + 1} de {questions.length}
                </p>
                <h3 className="text-2xl font-bold leading-tight sm:text-4xl">
                  <NoCopy>{question.title}</NoCopy>
                </h3>
                {phase === 'reading' && (
                  <p className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                    <Eye className="h-4 w-4" aria-hidden="true" />
                    Tiempo de lectura…
                  </p>
                )}
                {phase === 'answering' && (
                  <div className="space-y-3">
                    <p className={`font-mono text-5xl font-bold tabular-nums sm:text-6xl ${timeLeft <= 5 ? 'text-rose-500' : ''}`}>
                      {timeLeft}
                      <span className="text-2xl text-zinc-400">s</span>
                    </p>
                    <TimerBar phase={phase} timeLeft={timeLeft} total={room.time_per_question} />
                  </div>
                )}
                <div className="mx-auto max-w-md space-y-2">
                  <div className="flex items-center justify-between text-sm text-zinc-500 dark:text-zinc-400">
                    <span className="inline-flex items-center gap-1.5">
                      <Users className="h-4 w-4" aria-hidden="true" />
                      Respuestas
                    </span>
                    <span className="font-semibold tabular-nums text-zinc-700 dark:text-zinc-200">
                      {liveAnswers.length} / {participants.length}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                    <div className="h-full rounded-full bg-indigo-500 transition-all duration-300" style={{ width: `${answeredPct}%` }} />
                  </div>
                  <p className="text-xs text-zinc-400">El desglose se mostrará al agotarse el tiempo.</p>
                </div>
              </div>
            )}

            {room.status === 'showing_results' && question && (
              <div className="space-y-6">
                <div className="text-center">
                  <p className="text-sm font-medium uppercase tracking-widest text-zinc-400">Resultados</p>
                  <h3 className="mt-1 text-xl font-bold leading-tight sm:text-3xl">
                    <NoCopy>{question.title}</NoCopy>
                  </h3>
                </div>
                <div className="flex items-center gap-3 rounded-xl border border-emerald-500/50 bg-emerald-50 p-4 dark:bg-emerald-500/10">
                  <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-500" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-emerald-700/80 dark:text-emerald-400/80">
                      Respuesta correcta
                    </p>
                    <p className="font-semibold">
                      <span className="mr-1 text-emerald-600 dark:text-emerald-400">{question.correct_answer}.</span>
                      <NoCopy>{question.options[LETTERS.indexOf(question.correct_answer)]}</NoCopy>
                    </p>
                  </div>
                  {stats && (
                    <div className="ml-auto text-right">
                      <p className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{stats.pct}%</p>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">{stats.correct}/{stats.total} aciertos</p>
                    </div>
                  )}
                </div>
                <AnswerBreakdown question={question} answers={liveAnswers} showCorrect={true} />
                <div className="mx-auto max-w-sm">
                  <button className="btn" onClick={nextQuestion}>
                    {room.current_question_index + 1 < questions.length ? (
                      <>
                        <ChevronRight className="h-4 w-4" aria-hidden="true" />
                        Siguiente pregunta
                      </>
                    ) : (
                      <>
                        <Trophy className="h-4 w-4" aria-hidden="true" />
                        Ver ranking
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {room.status === 'finished' && (
              <div className="space-y-6">
                <Ranking roomId={room.id} />
                <div className="mx-auto max-w-sm">
                  <button className="btn-secondary" onClick={onExit}>
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    Volver al menú
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        </Panel>
      </motion.div>
    </Stage>
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
    <Stage>
      <motion.div initial={enter.initial} animate={enter.animate} transition={enterTransition}>
        <Panel className="space-y-6 p-6 sm:p-8">
          <ScreenHeader icon={Users} title="Unirse a una sala" subtitle="Elige tu nombre y una sala abierta" />
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault()
              join()
            }}
          >
            <div>
              <label htmlFor="participant-name" className="mb-1.5 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Tu nombre
              </label>
              <div className="relative">
                <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
                <input
                  id="participant-name"
                  className="input pl-9"
                  placeholder="Tu nombre"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
              {username.trim() && usernameError && (
                <p className="mt-1.5 flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400">
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {usernameError}
                </p>
              )}
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Elige una sala:</p>
                <button type="button" onClick={loadOpenRooms} className="btn-ghost">
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  Recargar salas
                </button>
              </div>
              {openRooms.length === 0 ? (
                <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                  No hay salas abiertas ahora mismo.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {openRooms.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      aria-pressed={selectedRoomId === r.id}
                      onClick={() => setSelectedRoomId(r.id)}
                      className={`text-center font-mono tracking-widest ${selectClasses(selectedRoomId === r.id)}`}
                    >
                      {r.id}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {error && (
              <p className="flex items-center gap-1.5 text-sm text-rose-600 dark:text-rose-400">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {error}
              </p>
            )}

            <button className="btn" type="submit" disabled={!canJoin}>
              <LogIn className="h-4 w-4" aria-hidden="true" />
              Entrar
            </button>
          </form>
        </Panel>
      </motion.div>
    </Stage>
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
    <Stage>
      <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-400">
            <User className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="truncate font-medium">{participant.username}</span>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-sm font-semibold tabular-nums dark:bg-zinc-800">
          {score}
          <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">pts</span>
        </span>
      </div>

      <Panel className="p-6 sm:p-8">
        <motion.div
          key={`${room.status}-${room.current_question_index}`}
          initial={enter.initial}
          animate={enter.animate}
          transition={enterTransition}
        >
          {['open', 'waiting', 'closed'].includes(room.status) && (
            <div className="flex flex-col items-center gap-4 py-10 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-indigo-500" aria-hidden="true" />
              <p className="text-lg font-medium">Espera a que empiece…</p>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">Mantén esta pantalla abierta</p>
            </div>
          )}

          {room.status === 'in_question' && question && (
            <div className="space-y-5">
              <h3 className="text-center text-xl font-bold leading-snug sm:text-2xl">
                <NoCopy>{question.title}</NoCopy>
              </h3>
              {phase === 'reading' && (
                <p className="flex items-center justify-center gap-1.5 text-center text-sm font-medium text-amber-600 dark:text-amber-400">
                  <Eye className="h-4 w-4" aria-hidden="true" />
                  Lee la pregunta…
                </p>
              )}
              {phase === 'answering' && (
                <div className="space-y-2">
                  <p className={`text-center font-mono text-4xl font-bold tabular-nums ${timeLeft <= 5 ? 'text-rose-500' : ''}`}>
                    {timeLeft}
                  </p>
                  <TimerBar phase={phase} timeLeft={timeLeft} total={room.time_per_question} />
                </div>
              )}
              <motion.div
                variants={listStagger}
                initial="hidden"
                animate="show"
                className="grid grid-cols-1 gap-3 sm:grid-cols-2"
              >
                {LETTERS.map((l, i) => {
                  const { Icon, solid, hover } = LETTER_META[l]
                  const selected = myAnswer?.answer === l
                  return (
                    <motion.button
                      key={l}
                      variants={listItem}
                      whileTap={disabled ? undefined : { scale: 0.97 }}
                      disabled={disabled}
                      onClick={() => answer(l)}
                      aria-label={`Opción ${l}: ${question.options[i]}`}
                      className={`relative flex min-h-[5rem] items-center gap-3 rounded-2xl p-4 text-left text-white shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50 ${solid} ${disabled ? '' : hover} ${
                        selected ? 'ring-4 ring-white ring-offset-2 ring-offset-zinc-50 dark:ring-offset-zinc-950' : ''
                      }`}
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/20">
                        <Icon className="h-5 w-5" aria-hidden="true" />
                      </span>
                      <span className="font-semibold leading-snug">
                        <span className="mr-1 opacity-80">{l}.</span>
                        <NoCopy>{question.options[i]}</NoCopy>
                      </span>
                      {selected && <Check className="ml-auto h-5 w-5 shrink-0" aria-hidden="true" />}
                    </motion.button>
                  )
                })}
              </motion.div>
              {myAnswer && (
                <p role="status" className="flex items-center justify-center gap-1.5 text-center text-sm font-medium text-zinc-500 dark:text-zinc-400">
                  <Check className="h-4 w-4 text-emerald-500" aria-hidden="true" />
                  Respuesta enviada
                </p>
              )}
            </div>
          )}

          {room.status === 'showing_results' && question && (
            <div className="space-y-5 text-center">
              <h3 className="text-lg font-bold leading-snug sm:text-2xl">
                <NoCopy>{question.title}</NoCopy>
              </h3>
              <motion.div
                initial={{ scale: 0.85, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 18 }}
                className="flex flex-col items-center gap-2"
              >
                {myAnswer ? (
                  myAnswer.is_correct ? (
                    <>
                      <CheckCircle2 className="h-16 w-16 text-emerald-500" aria-hidden="true" />
                      <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">¡Correcto!</p>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-16 w-16 text-rose-500" aria-hidden="true" />
                      <p className="text-2xl font-bold text-rose-600 dark:text-rose-400">Incorrecto</p>
                    </>
                  )
                ) : (
                  <>
                    <MinusCircle className="h-16 w-16 text-zinc-400" aria-hidden="true" />
                    <p className="text-xl font-semibold text-zinc-500 dark:text-zinc-400">No respondiste</p>
                  </>
                )}
              </motion.div>
              <div className="rounded-xl border border-emerald-500/40 bg-emerald-50 p-3 dark:bg-emerald-500/10">
                <p className="text-xs font-medium uppercase tracking-wide text-emerald-700/80 dark:text-emerald-400/80">
                  Respuesta correcta
                </p>
                <p className="font-semibold">
                  <span className="mr-1 text-emerald-600 dark:text-emerald-400">{question.correct_answer}.</span>
                  <NoCopy>{question.options[LETTERS.indexOf(question.correct_answer)]}</NoCopy>
                </p>
              </div>
              {stats && (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Acierto del grupo:{' '}
                  <span className="font-semibold text-zinc-700 dark:text-zinc-200">{stats.pct}%</span> ({stats.correct}/{stats.total})
                </p>
              )}
              <p className="flex items-center justify-center gap-1.5 text-sm text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Esperando la siguiente…
              </p>
            </div>
          )}

          {room.status === 'finished' && <Ranking roomId={room.id} highlightId={participant.id} />}
        </motion.div>
      </Panel>
    </Stage>
  )
}

// ---------- SHELL ----------

function Header({ theme, setTheme }) {
  return (
    <header className="sticky top-0 z-20 border-b border-zinc-200/70 bg-zinc-50/80 backdrop-blur dark:border-zinc-800/70 dark:bg-zinc-950/80">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white">
            <Target className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="font-semibold tracking-tight">ArenaQuiz</span>
        </div>
        <ThemeToggle theme={theme} setTheme={setTheme} />
      </div>
    </header>
  )
}

function RoleSelect({ onPick }) {
  return (
    <Stage>
      <motion.div initial={enter.initial} animate={enter.animate} transition={enterTransition}>
        <div className="mb-8 text-center">
          <span className="mx-auto mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/25">
            <Target className="h-7 w-7" aria-hidden="true" />
          </span>
          <h1 className="text-3xl font-bold tracking-tight">ArenaQuiz</h1>
          <p className="mt-2 text-zinc-500 dark:text-zinc-400">Quizzes y encuestas en tiempo real</p>
        </div>
        <div className="grid gap-3">
          <MenuCard icon={Target} title="Soy Admin" desc="Crea y dirige salas en vivo" onClick={() => onPick('admin')} accent />
          <MenuCard icon={Users} title="Soy Participante" desc="Únete con tu nombre y juega" onClick={() => onPick('participant')} />
        </div>
      </motion.div>
    </Stage>
  )
}

export default function App() {
  const [theme, setTheme] = useTheme()
  const [role, setRole] = useState(null)

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <Header theme={theme} setTheme={setTheme} />
        <main className="px-4 py-8 sm:py-12">
          {!role ? (
            <RoleSelect onPick={setRole} />
          ) : role === 'admin' ? (
            <AdminApp />
          ) : (
            <ParticipantApp />
          )}
        </main>
      </div>
    </MotionConfig>
  )
}
