import { useCallback, useEffect, useRef, useState } from 'react'
import { Game, type HudState, type MinimapData } from '../game/Game'
import { defaultQualityLevel, type QualityLevel } from '../game/quality'
import { Hud } from './Hud'
import { fullscreenSupported, isFullscreen, onFullscreenChange, toggleFullscreen } from './fullscreen'
import styles from './App.module.css'

const QUALITY_KEY = 'neonrush:quality'
const QUALITY_LABEL: Record<QualityLevel, string> = { ultra: 'Ультра', high: 'Высокое', low: 'Низкое' }

function readQuality(): QualityLevel {
  try {
    const q = localStorage.getItem(QUALITY_KEY)
    if (q === 'ultra' || q === 'high' || q === 'low') return q
  } catch {
    /* нет доступа к localStorage */
  }
  return defaultQualityLevel()
}

type Phase = 'loading' | 'ready' | 'playing' | 'paused' | 'error'

export function App() {
  const host = useRef<HTMLDivElement>(null)
  const game = useRef<Game | null>(null)
  const [quality, setQuality] = useState<QualityLevel>(readQuality)
  const [phase, setPhase] = useState<Phase>('loading')
  const [progress, setProgress] = useState({ label: 'Загрузка', value: 0 })
  const [hud, setHud] = useState<HudState | null>(null)
  const [backend, setBackend] = useState('')
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState('')
  const [fullscreen, setFullscreen] = useState(isFullscreen)
  const [minimap, setMinimap] = useState<MinimapData | null>(null)
  const [resultsHidden, setResultsHidden] = useState(false)
  const started = useRef(false)

  useEffect(() => {
    if (!host.current) return
    const g = new Game(host.current, quality)
    game.current = g
    let alive = true
    g.onProgress = (label, value) => alive && setProgress({ label, value })
    g.onHud = (s) => alive && setHud(s)
    setPhase('loading')
    g.init()
      .then(() => {
        if (!alive) return
        setBackend(g.backend)
        setMinimap(g.minimap)
        if (started.current) {
          void g.startAudio().then(() => g.startRace())
          setPhase('playing')
        } else {
          g.setPaused(true)
          setPhase('ready')
        }
      })
      .catch((e: unknown) => {
        console.error(e)
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setPhase('error')
      })
    return () => {
      alive = false
      g.dispose()
      game.current = null
    }
  }, [quality])

  const start = useCallback(async () => {
    const g = game.current
    if (!g) return
    started.current = true
    await g.startAudio()
    g.setMuted(muted)
    g.setPaused(false)
    g.startRace()
    setPhase('playing')
  }, [muted])

  const restart = useCallback(() => {
    setResultsHidden(false)
    game.current?.restartRace()
  }, [])

  const togglePause = useCallback(() => {
    const g = game.current
    if (!g) return
    setPhase((p) => {
      if (p === 'playing') {
        g.setPaused(true)
        return 'paused'
      }
      if (p === 'paused') {
        g.setPaused(false)
        return 'playing'
      }
      return p
    })
  }, [])

  useEffect(() => onFullscreenChange(() => setFullscreen(isFullscreen())), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyF' && !e.repeat) void toggleFullscreen()
      if (e.code === 'Escape' || e.code === 'KeyP') togglePause()
      if (e.code === 'Enter' && phase === 'ready') void start()
      else if (e.code === 'Enter' && hud?.phase === 'finished' && !resultsHidden) restart()
      if (e.code === 'KeyM') {
        setMuted((m) => {
          game.current?.setMuted(!m)
          return !m
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePause, start, phase, hud?.phase, resultsHidden, restart])

  const changeQuality = (q: QualityLevel) => {
    try {
      localStorage.setItem(QUALITY_KEY, q)
    } catch {
      /* запомнить не получится, но качество сменим */
    }
    setQuality(q)
  }

  const showMenu = phase === 'ready' || phase === 'paused'

  return (
    <div className={styles.app}>
      <div ref={host} className={styles.canvas} />

      {(phase === 'playing' || phase === 'paused') && hud && (
        <Hud
          state={hud}
          backend={backend}
          muted={muted}
          quality={QUALITY_LABEL[quality]}
          fullscreen={fullscreenSupported() ? fullscreen : null}
          onFullscreen={toggleFullscreen}
          minimap={minimap}
        />
      )}

      {phase === 'playing' && hud?.results && !resultsHidden && (
        <div className={styles.menuWrap}>
          <div className={styles.menu}>
            <h2 className={styles.resultsTitle}>
              {hud.position === 1 ? 'Победа!' : `Финиш: ${hud.position}-е место`}
            </h2>
            <ol className={styles.results}>
              {hud.results.map((r, i) => (
                <li key={r.name} className={r.me ? styles.resultMe : ''}>
                  <span className={styles.resultPos}>{i + 1}</span>
                  <span className={styles.resultName}>{r.name}</span>
                  <span className={styles.resultTime}>{r.time !== null ? fmtTime(r.time) : 'едет…'}</span>
                  <span className={styles.resultBest}>{r.best !== null ? `круг ${fmtTime(r.best)}` : ''}</span>
                </li>
              ))}
            </ol>
            <button className={styles.primary} onClick={restart} autoFocus>
              Ещё заезд <kbd>Enter</kbd>
            </button>
            <button className={styles.secondary} onClick={() => setResultsHidden(true)}>
              Покататься по городу
            </button>
          </div>
        </div>
      )}

      {phase === 'loading' && (
        <div className={styles.loading}>
          <Logo />
          <div className={styles.bar}>
            <div className={styles.barFill} style={{ width: `${Math.round(progress.value * 100)}%` }} />
          </div>
          <p className={styles.loadingLabel}>{progress.label}…</p>
        </div>
      )}

      {showMenu && (
        <div className={styles.menuWrap}>
          <div className={styles.menu}>
            <Logo />
            <p className={styles.tagline}>Ночной город, мокрый асфальт, пять соперников и три круга по 2,8 км: через тоннель и над рекой.</p>

            <button className={styles.primary} onClick={phase === 'ready' ? start : togglePause} autoFocus>
              {phase === 'ready' ? 'Поехали' : 'Продолжить'}
              <kbd>{phase === 'ready' ? 'Enter' : 'Esc'}</kbd>
            </button>

            <div className={styles.controls}>
              <Row keys={['W', '↑']} label="Газ" />
              <Row keys={['S', '↓']} label="Тормоз и задний ход" />
              <Row keys={['A', 'D']} label="Руль" />
              <Row keys={['Пробел']} label="Ручник — занос" />
              <Row keys={['Shift']} label="Нитро" />
              <Row keys={['C']} label="Камера" />
              <Row keys={['R']} label="Вернуть на трассу" />
              <Row keys={['M']} label="Звук" />
              <Row keys={['F']} label="Полный экран" />
              <Row keys={['Esc']} label="Пауза" />
            </div>
            <p className={styles.hint}>Геймпад тоже работает: курки, стик, A — ручник, B — нитро, Y — камера.</p>

            {fullscreenSupported() && (
              <button className={styles.secondary} onClick={() => void toggleFullscreen()}>
                {fullscreen ? 'Выйти из полного экрана' : 'На весь экран'}
              </button>
            )}

            <label className={styles.quality}>
              <span>Графика</span>
              <div className={styles.segmented} role="radiogroup">
                {(['low', 'high', 'ultra'] as const).map((q) => (
                  <button
                    key={q}
                    role="radio"
                    aria-checked={quality === q}
                    className={quality === q ? styles.segActive : ''}
                    onClick={() => changeQuality(q)}
                  >
                    {QUALITY_LABEL[q]}
                  </button>
                ))}
              </div>
            </label>
            {backend && (
              <p className={styles.backend}>
                Рендер: <b>{backend}</b>
                {backend !== 'WebGPU' && ' — браузер без WebGPU, картинка будет проще'}
              </p>
            )}
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className={styles.menuWrap}>
          <div className={styles.menu}>
            <Logo />
            <p className={styles.tagline}>Не удалось запустить графику. Нужен браузер с WebGPU или WebGL 2: свежий Chrome, Edge, Safari или Firefox.</p>
            <pre className={styles.error}>{error}</pre>
            <button className={styles.primary} onClick={() => changeQuality('low')}>
              Попробовать на низком качестве
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className={styles.row}>
      <span className={styles.keys}>
        {keys.map((k) => (
          <kbd key={k}>{k}</kbd>
        ))}
      </span>
      <span>{label}</span>
    </div>
  )
}

function Logo() {
  return (
    <h1 className={styles.logo}>
      <span>NEON</span>
      <span className={styles.logoRush}>RUSH</span>
    </h1>
  )
}

function fmtTime(t: number) {
  const m = Math.floor(t / 60)
  const sec = t - m * 60
  return `${m}:${sec.toFixed(3).padStart(6, '0')}`
}
