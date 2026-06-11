import { useState, useEffect, useRef } from 'react'
import { supabase } from './supabaseClient'

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

function useCurrentQuestion(room) {
  const [question, setQuestion] = useState(null)
  useEffect(() => {
    if (!room || !['in_question', 'showing_results'].includes(room.status)) {
      setQuestion(null)
      return
    }
    supabase
      .from('questions')
      .select('*')
      .eq('room_id', room.id)
      .eq('question_number', room.current_question_index)
      .single()
      .then(({ data }) => setQuestion(data))
  }, [room?.id, room?.status === 'in_question' || room?.status === 'showing_results', room?.current_question_index])
  return question
}

function useQuestionStats(room, question) {
  const [stats, setStats] = useState(null)
  useEffect(() => {
    if (room?.status !== 'showing_results' || !question) {
      setStats(null)
      return
    }
    supabase
      .from('answers')
      .select('is_correct')
      .eq('question_id', question.id)
      .then(({ data }) => {
        const total = data?.length ?? 0
        const correct = data?.filter((a) => a.is_correct).length ?? 0
        setStats({ total, correct, pct: total ? Math.round((correct / total) * 100) : 0 })
      })
  }, [room?.status, question?.id])
  return stats
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
  const [token, setToken] = useState('')
  const [loggedIn, setLoggedIn] = useState(false)
  const [room, setRoom] = useState(null)
  const [timePerQuestion, setTimePerQuestion] = useState(15)

  if (!loggedIn) {
    return (
      <Card title="Admin · Login">
        <input
          className="input"
          placeholder="Token (cualquier string)"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <button className="btn" disabled={!token.trim()} onClick={() => setLoggedIn(true)}>
          Entrar
        </button>
      </Card>
    )
  }

  if (!room) {
    const createRoom = async () => {
      const id = generateRoomCode()
      const { data, error } = await supabase
        .from('rooms')
        .insert({
          id,
          admin_id: token,
          status: 'waiting',
          current_question_index: 0,
          time_per_question: timePerQuestion,
        })
        .select()
        .single()
      if (error) return alert(error.message)
      setRoom(data)
    }
    return (
      <Card title="Crear sala">
        <label className="block text-sm">
          Segundos por pregunta (10-15)
          <input
            type="number"
            min="10"
            max="15"
            className="input"
            value={timePerQuestion}
            onChange={(e) => setTimePerQuestion(Number(e.target.value))}
          />
        </label>
        <button className="btn" onClick={createRoom}>
          Crear sala
        </button>
      </Card>
    )
  }

  return <AdminRoom room={room} setRoom={setRoom} />
}

function AdminRoom({ room, setRoom }) {
  const [participants, setParticipants] = useState([])
  const [questions, setQuestions] = useState([])
  const [liveAnswers, setLiveAnswers] = useState([])
  const question = useCurrentQuestion(room)
  const stats = useQuestionStats(room, question)

  useRoomSubscription(room.id, setRoom)

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

  // Respuestas en vivo de la pregunta actual (solo el admin lo necesita)
  useEffect(() => {
    setLiveAnswers([])
    if (!question || room.status !== 'in_question') return
    supabase
      .from('answers')
      .select('*')
      .eq('question_id', question.id)
      .then(({ data }) => setLiveAnswers(data ?? []))
    const channel = supabase
      .channel(`answers-${question.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'answers', filter: `question_id=eq.${question.id}` },
        (payload) => setLiveAnswers((prev) => [...prev, payload.new]),
      )
      .subscribe()
    return () => supabase.removeChannel(channel)
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
        <button className="btn" onClick={() => updateRoom({ status: 'open' })}>
          Abrir sala
        </button>
      )}

      {room.status === 'open' && (
        <>
          <QuestionForm room={room} questions={questions} setQuestions={setQuestions} />
          <h3 className="font-bold mt-4">Participantes ({participants.length})</h3>
          <ul className="text-sm text-slate-300">
            {participants.map((p) => (
              <li key={p.id}>• {p.username}</li>
            ))}
          </ul>
          <button
            className="btn bg-orange-600 hover:bg-orange-500"
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
            Pregunta {room.current_question_index + 1}: {question.title}
          </h3>
          {phase === 'reading' && <p className="text-amber-400">📖 Tiempo de lectura...</p>}
          {phase === 'answering' && (
            <p className="text-3xl font-mono text-center">⏱ {timeLeft}s</p>
          )}
          <p>
            Respuestas en vivo: {liveAnswers.length} / {participants.length}
          </p>
          <ul className="text-sm text-slate-300">
            {LETTERS.map((l) => (
              <li key={l}>
                {l}: {liveAnswers.filter((a) => a.answer === l).length}
              </li>
            ))}
          </ul>
        </>
      )}

      {room.status === 'showing_results' && question && (
        <>
          <h3 className="text-xl font-bold">{question.title}</h3>
          <p className="text-green-400">
            ✔ Correcta: {question.correct_answer} —{' '}
            {question.options[LETTERS.indexOf(question.correct_answer)]}
          </p>
          {stats && (
            <p>
              Acierto: {stats.pct}% ({stats.correct}/{stats.total})
            </p>
          )}
          <button className="btn" onClick={nextQuestion}>
            {room.current_question_index + 1 < questions.length ? 'Siguiente' : 'Finalizar'}
          </button>
        </>
      )}

      {room.status === 'finished' && <Ranking roomId={room.id} />}
    </Card>
  )
}

function QuestionForm({ room, questions, setQuestions }) {
  const [title, setTitle] = useState('')
  const [options, setOptions] = useState(['', '', '', ''])
  const [correct, setCorrect] = useState('A')

  useEffect(() => {
    supabase
      .from('questions')
      .select('*')
      .eq('room_id', room.id)
      .order('question_number')
      .then(({ data }) => setQuestions(data ?? []))
  }, [room.id])

  const addQuestion = async () => {
    const { data, error } = await supabase
      .from('questions')
      .insert({
        room_id: room.id,
        question_number: questions.length,
        title,
        options,
        correct_answer: correct,
      })
      .select()
      .single()
    if (error) return alert(error.message)
    setQuestions([...questions, data])
    setTitle('')
    setOptions(['', '', '', ''])
    setCorrect('A')
  }

  const valid = title.trim() && options.every((o) => o.trim())

  return (
    <div className="space-y-2 border border-slate-700 rounded p-3">
      <h3 className="font-bold">Agregar pregunta ({questions.length} creadas)</h3>
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
            onChange={(e) =>
              setOptions(options.map((o, j) => (j === i ? e.target.value : o)))
            }
          />
        </div>
      ))}
      <button className="btn" disabled={!valid} onClick={addQuestion}>
        Agregar
      </button>
    </div>
  )
}

// ---------- PARTICIPANTE ----------

function ParticipantApp() {
  const [username, setUsername] = useState('')
  const [participant, setParticipant] = useState(null)
  const [room, setRoom] = useState(null)
  const [code, setCode] = useState('')
  const [openRooms, setOpenRooms] = useState([])

  useEffect(() => {
    if (participant) return
    supabase
      .from('rooms')
      .select('*')
      .eq('status', 'open')
      .then(({ data }) => setOpenRooms(data ?? []))
  }, [participant])

  const join = async (roomId) => {
    const { data: r, error } = await supabase
      .from('rooms')
      .select('*')
      .eq('id', roomId.toUpperCase().trim())
      .single()
    if (error || !r) return alert('Sala no encontrada')
    if (r.status !== 'open') return alert('La sala no está abierta')
    const { data: p, error: pErr } = await supabase
      .from('participants')
      .insert({ room_id: r.id, username: username.trim(), score: 0 })
      .select()
      .single()
    if (pErr) return alert(pErr.message)
    setRoom(r)
    setParticipant(p)
  }

  if (participant && room) {
    return <ParticipantRoom room={room} setRoom={setRoom} participant={participant} />
  }

  return (
    <Card title="Unirse a una sala">
      <input
        className="input"
        placeholder="Tu nombre"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <div className="flex gap-2">
        <input
          className="input flex-1 uppercase"
          placeholder="Código (6 chars)"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button className="btn" disabled={!username.trim() || code.length !== 6} onClick={() => join(code)}>
          Entrar
        </button>
      </div>
      {openRooms.length > 0 && (
        <>
          <p className="text-sm text-slate-400">Salas abiertas:</p>
          {openRooms.map((r) => (
            <button
              key={r.id}
              className="btn w-full bg-slate-700 hover:bg-slate-600"
              disabled={!username.trim()}
              onClick={() => join(r.id)}
            >
              {r.id}
            </button>
          ))}
        </>
      )}
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
    const isCorrect = letter === question.correct_answer
    setMyAnswer({ answer: letter, is_correct: isCorrect })
    const { error } = await supabase.from('answers').insert({
      question_id: question.id,
      participant_id: participant.id,
      answer: letter,
      is_correct: isCorrect,
    })
    if (error) return
    if (isCorrect) {
      const newScore = score + 100
      setScore(newScore)
      await supabase.from('participants').update({ score: newScore }).eq('id', participant.id)
    }
  }

  const disabled = phase !== 'answering' || timeLeft <= 0 || !!myAnswer

  return (
    <Card title={`Sala ${room.id} · ${participant.username} · ${score} pts`}>
      {['open', 'waiting', 'closed'].includes(room.status) && (
        <p className="text-center text-lg">⏳ Esperando que empiece...</p>
      )}

      {room.status === 'in_question' && question && (
        <>
          <h3 className="text-xl font-bold text-center">{question.title}</h3>
          {phase === 'reading' && <p className="text-center text-amber-400">📖 Lee la pregunta...</p>}
          {phase === 'answering' && (
            <p className="text-4xl font-mono text-center">{timeLeft}</p>
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
                {l}: {question.options[i]}
              </button>
            ))}
          </div>
          {myAnswer && <p className="text-center text-slate-300">Respuesta enviada ✔</p>}
        </>
      )}

      {room.status === 'showing_results' && question && (
        <>
          <h3 className="text-xl font-bold text-center">{question.title}</h3>
          {myAnswer ? (
            <p className={`text-center text-2xl ${myAnswer.is_correct ? 'text-green-400' : 'text-red-400'}`}>
              {myAnswer.is_correct ? '🎉 ¡Acertaste!' : '❌ Fallaste'}
            </p>
          ) : (
            <p className="text-center text-slate-400">No respondiste</p>
          )}
          <p className="text-center text-green-400">
            Correcta: {question.correct_answer} —{' '}
            {question.options[LETTERS.indexOf(question.correct_answer)]}
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
