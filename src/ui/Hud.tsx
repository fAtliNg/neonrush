import type { HudState, MinimapData } from '../game/Game'
import { Minimap } from './Minimap'
import styles from './Hud.module.css'

function fmt(t: number | null) {
  if (t === null) return '—:——.———'
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(3).padStart(6, '0')}`
}

interface Props {
  state: HudState
  backend: string
  muted: boolean
  quality: string
  /** null — браузер не умеет полноэкранный режим */
  fullscreen: boolean | null
  onFullscreen: () => void
  minimap: MinimapData | null
}

export function Hud({ state, backend, muted, quality, fullscreen, onFullscreen, minimap }: Props) {
  const rpmK = Math.min(1, state.rpm / 8200)
  const redline = state.rpm > 7200
  const gear = state.gear === 0 ? 'R' : String(state.gear)
  // Дуга тахометра: 240° из окружности
  const R = 74
  const C = 2 * Math.PI * R
  const arc = C * (240 / 360)
  return (
    <div className={styles.hud}>
      <div className={styles.lap}>
        <div className={styles.position}>
          <b>{state.position}</b>
          <span>/{state.racers}</span>
        </div>
        <div className={styles.lapNum}>
          КРУГ <b>{state.lap}</b>/{state.laps}
        </div>
        <div className={styles.lapTime}>{fmt(state.lapTime)}</div>
        <div className={styles.lapRow}>
          <span>Гонка</span>
          <b>{fmt(state.raceTime)}</b>
        </div>
        <div className={styles.lapRow}>
          <span>Прошлый</span>
          <b>{fmt(state.lastLap)}</b>
        </div>
        <div className={styles.lapRow}>
          <span>Лучший</span>
          <b className={styles.best}>{fmt(state.bestLap)}</b>
        </div>
      </div>

      <div className={styles.meta}>
        <span>{state.fps} FPS</span>
        <span>{backend}</span>
        <span>{quality}</span>
        <span>Камера: {state.camera}</span>
        {muted && <span>Звук выкл.</span>}
        {fullscreen !== null && (
          <button className={styles.fsButton} onClick={onFullscreen} title="Полный экран (F)" aria-label={fullscreen ? 'Выйти из полного экрана' : 'На весь экран'}>
            {fullscreen ? (
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
              </svg>
            )}
          </button>
        )}
      </div>

      {(state.drift > 0 || state.driftBank > 0) && (
        <div className={styles.drift}>
          {state.drift > 0 && <div className={styles.driftNow}>ЗАНОС +{state.drift.toLocaleString('ru-RU')}</div>}
          <div className={styles.driftTotal}>Очки заносов: {state.driftBank.toLocaleString('ru-RU')}</div>
        </div>
      )}

      {state.countdown !== null && (
        <div key={state.countdown} className={`${styles.countdown} ${state.countdown === 0 ? styles.go : ''}`}>
          {state.countdown === 0 ? 'СТАРТ!' : state.countdown}
        </div>
      )}

      {minimap && <Minimap map={minimap} cars={state.cars} />}

      <div className={styles.gauge}>
        <svg viewBox="0 0 180 180" className={styles.dial} aria-hidden>
          <defs>
            <linearGradient id="rpmGrad" x1="0" x2="1" y1="1" y2="0">
              <stop offset="0" stopColor="#2bf0ff" />
              <stop offset="0.7" stopColor="#8b5cff" />
              <stop offset="1" stopColor="#ff2bd6" />
            </linearGradient>
          </defs>
          <circle cx="90" cy="90" r={R} className={styles.track} strokeDasharray={`${arc} ${C}`} transform="rotate(150 90 90)" />
          <circle
            cx="90"
            cy="90"
            r={R}
            className={styles.fill}
            stroke={redline ? '#ff3b5c' : 'url(#rpmGrad)'}
            strokeDasharray={`${arc * rpmK} ${C}`}
            transform="rotate(150 90 90)"
          />
        </svg>
        <div className={styles.speed}>
          <b>{state.speed}</b>
          <span>км/ч</span>
        </div>
        <div className={`${styles.gear} ${redline ? styles.gearRed : ''}`}>{gear}</div>
        <div className={styles.nitro}>
          <div className={styles.nitroLabel}>N₂O</div>
          <div className={styles.nitroBar}>
            <div className={`${styles.nitroFill} ${state.nitroActive ? styles.nitroOn : ''}`} style={{ width: `${state.nitro * 100}%` }} />
          </div>
        </div>
      </div>
    </div>
  )
}
