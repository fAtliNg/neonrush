import { CatmullRomCurve3, Vector3 } from 'three/webgpu'

/** Ширина проезжей части, м */
export const ROAD_WIDTH = 16
export const HALF_WIDTH = ROAD_WIDTH / 2
/** Шаг дискретизации трассы, м */
const STEP = 1

/** Опорные точки кольца (x, z). Трасса плоская: y = 0, так работает зеркало мокрого асфальта. */
const CONTROL: Array<[number, number]> = [
  [0, 0],
  [200, 0],
  [310, -20],
  [370, -100],
  [350, -200],
  [260, -245],
  [160, -230],
  [95, -280],
  [80, -370],
  [140, -440],
  [270, -465],
  [420, -430],
  [520, -340],
  [565, -190],
  [560, 20],
  [490, 150],
  [330, 205],
  [120, 195],
  [-50, 165],
  [-140, 95],
  [-110, 15],
]

export interface TrackPoint {
  x: number
  z: number
  /** Касательная (направление движения) */
  tx: number
  tz: number
  /** Нормаль влево от направления движения */
  nx: number
  nz: number
  /** Кривизна со знаком, 1/м */
  curvature: number
}

export interface Nearest {
  index: number
  /** Пройденное расстояние вдоль трассы, м */
  s: number
  /** Смещение от оси влево (+) или вправо (−), м */
  lateral: number
  point: TrackPoint
}

export class Track {
  readonly points: TrackPoint[] = []
  readonly length: number

  constructor() {
    const curve = new CatmullRomCurve3(
      CONTROL.map(([x, z]) => new Vector3(x, 0, z)),
      true,
      'centripetal',
    )
    const rough = curve.getLength()
    const count = Math.round(rough / STEP)
    const spaced = curve.getSpacedPoints(count)
    spaced.pop() // замкнутая кривая повторяет первую точку
    this.length = rough

    const n = spaced.length
    for (let i = 0; i < n; i++) {
      const prev = spaced[(i - 1 + n) % n]
      const next = spaced[(i + 1) % n]
      let tx = next.x - prev.x
      let tz = next.z - prev.z
      const len = Math.hypot(tx, tz) || 1
      tx /= len
      tz /= len
      this.points.push({ x: spaced[i].x, z: spaced[i].z, tx, tz, nx: tz, nz: -tx, curvature: 0 })
    }
    for (let i = 0; i < n; i++) {
      const a = this.points[(i - 3 + n) % n]
      const b = this.points[(i + 3) % n]
      const cross = a.tx * b.tz - a.tz * b.tx
      this.points[i].curvature = -Math.asin(Math.max(-1, Math.min(1, cross))) / (6 * STEP)
    }
  }

  get count() {
    return this.points.length
  }

  at(index: number) {
    const n = this.points.length
    return this.points[((index % n) + n) % n]
  }

  /** Точка на расстоянии s вдоль трассы со смещением lateral влево */
  sample(s: number, lateral = 0) {
    const n = this.points.length
    const f = (((s / STEP) % n) + n) % n
    const i = Math.floor(f)
    const t = f - i
    const a = this.points[i]
    const b = this.points[(i + 1) % n]
    const x = a.x + (b.x - a.x) * t
    const z = a.z + (b.z - a.z) * t
    let tx = a.tx + (b.tx - a.tx) * t
    let tz = a.tz + (b.tz - a.tz) * t
    const len = Math.hypot(tx, tz) || 1
    tx /= len
    tz /= len
    return { x: x + tz * lateral, z: z - tx * lateral, tx, tz }
  }

  /** Ближайшая точка оси. hint — индекс с прошлого кадра, чтобы не перебирать всю трассу. */
  nearest(x: number, z: number, hint = -1): Nearest {
    const n = this.points.length
    let best = -1
    let bestD = Infinity
    const scan = (from: number, to: number) => {
      for (let k = from; k <= to; k++) {
        const i = ((k % n) + n) % n
        const p = this.points[i]
        const d = (p.x - x) ** 2 + (p.z - z) ** 2
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
    }
    if (hint >= 0) scan(hint - 40, hint + 40)
    if (hint < 0 || bestD > 30 * 30) scan(0, n - 1)

    const p = this.points[best]
    const dx = x - p.x
    const dz = z - p.z
    const along = dx * p.tx + dz * p.tz
    return {
      index: best,
      s: best * STEP + along,
      lateral: dx * p.nx + dz * p.nz,
      point: p,
    }
  }

  /** Минимальное расстояние от точки до оси трассы (для расстановки зданий) */
  distanceTo(x: number, z: number) {
    let best = Infinity
    for (let i = 0; i < this.points.length; i += 4) {
      const p = this.points[i]
      const d = (p.x - x) ** 2 + (p.z - z) ** 2
      if (d < best) best = d
    }
    return Math.sqrt(best)
  }
}
