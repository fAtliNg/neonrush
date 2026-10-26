import type { HudState, MinimapData } from '../game/Game'
import styles from './Minimap.module.css'

export function Minimap({ map, cars }: { map: MinimapData; cars: HudState['cars'] }) {
  const [vx, vy, vw, vh] = map.viewBox.split(' ').map(Number)
  const unit = Math.max(vw, vh) / 100 // единица толщины линий в процентах карты
  const me = cars.find((c) => c.me)
  return (
    <div className={styles.map} aria-label="Мини-карта">
      <svg viewBox={map.viewBox} preserveAspectRatio="xMidYMid meet">
        <defs>
          <clipPath id="mmClip">
            <rect x={vx} y={vy} width={vw} height={vh} />
          </clipPath>
        </defs>
        <g clipPath="url(#mmClip)">
          <line
            x1={map.river[0]}
            y1={map.river[1]}
            x2={map.river[2]}
            y2={map.river[3]}
            stroke="rgba(43, 140, 255, 0.35)"
            strokeWidth={unit * 9}
            strokeLinecap="butt"
          />
        </g>
        <path d={map.path} className={styles.road} strokeWidth={unit * 3.4} />
        <path d={map.path} className={styles.line} strokeWidth={unit * 1.2} />
        <path d={map.tunnel} className={styles.tunnel} strokeWidth={unit * 3.6} />
        {map.dividers.map((d, i) => (
          <path key={i} d={d} className={styles.divider} strokeWidth={unit * 0.6} />
        ))}
        {map.bridges.map(([x, z], i) => (
          <circle key={i} cx={x} cy={z} r={unit * 2.2} className={styles.bridge} strokeWidth={unit * 0.6} />
        ))}
        <rect
          x={map.start[0] - unit * 3}
          y={map.start[1] - unit * 0.7}
          width={unit * 6}
          height={unit * 1.4}
          fill="#fff"
          transform={`rotate(${-map.start[2]} ${map.start[0]} ${map.start[1]})`}
        />
        {cars
          .filter((c) => !c.me)
          .map((c, i) => (
            <circle key={i} cx={c.x} cy={c.z} r={unit * 2} fill={c.color} stroke="#000" strokeWidth={unit * 0.5} />
          ))}
        {me && <circle cx={me.x} cy={me.z} r={unit * 2.8} className={styles.me} strokeWidth={unit * 0.8} />}
      </svg>
    </div>
  )
}
