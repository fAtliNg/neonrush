import { HALF_WIDTH, Track } from './track'
import { CarPhysics } from './physics'
import type { Controls } from './input'
import type { CarLivery, CarRig } from './car'
import { DIVIDERS, DIVIDER_HALF, GANTRIES } from './features'

export const LAPS = 3

export interface BotProfile {
  name: string
  livery: CarLivery
  /** 0.85–1: насколько близко к пределу сцепления едет и как рано тормозит */
  skill: number
}

export const BOTS: BotProfile[] = [
  { name: 'Вайпер', skill: 0.96, livery: { low: '#8a0a0a', high: '#ff2b2b', stripe: '#ffd23c', glow: '#ff3b5c' } },
  { name: 'Ронин', skill: 0.92, livery: { low: '#0a3a8a', high: '#2b8cff', stripe: '#ffffff', glow: '#2b8cff' } },
  { name: 'Нова', skill: 0.89, livery: { low: '#0a5a2a', high: '#2bff8a', stripe: '#111111', glow: '#2bff9a' } },
  { name: 'Блиц', skill: 0.86, livery: { low: '#7a4a00', high: '#ffb02e', stripe: '#111111', glow: '#ffb02e' } },
  { name: 'Кобра', skill: 0.83, livery: { low: '#7a7a86', high: '#f2f2f8', stripe: '#ff2bd6', glow: '#ff2bd6' } },
]

export class Racer {
  readonly physics: CarPhysics
  /** Сколько раз пересечена линия: −1 — ещё стоим на решётке перед ней */
  crossings = -1
  lastS = 0
  halfway = false
  lapStart = 0
  bestLap: number | null = null
  finishTime: number | null = null

  constructor(
    track: Track,
    readonly name: string,
    readonly rig: CarRig,
    readonly color: string,
    readonly bot: BotDriver | null,
  ) {
    this.physics = new CarPhysics(track)
  }

  get lap() {
    return Math.max(1, Math.min(LAPS, this.crossings + 1))
  }

  /** Пройденная дистанция для расстановки мест */
  progress(L: number) {
    const s = ((this.physics.trackS % L) + L) % L
    // До первого пересечения линии машина стоит перед ней, s близко к L
    return this.crossings * L + s
  }

  /** Обновляет круги. Возвращает время круга, если круг только что закрыт. */
  updateLap(L: number, clock: number): number | null {
    if (this.finishTime !== null) return null
    const s = ((this.physics.trackS % L) + L) % L
    let lapTime: number | null = null
    if (s > L * 0.4 && s < L * 0.6) this.halfway = true
    if (this.lastS > L - 60 && s < 60) {
      if (this.crossings < 0) {
        this.crossings = 0
        this.lapStart = clock
      } else if (this.halfway) {
        lapTime = clock - this.lapStart
        if (this.bestLap === null || lapTime < this.bestLap) this.bestLap = lapTime
        this.crossings++
        this.lapStart = clock
        this.halfway = false
        if (this.crossings >= LAPS) this.finishTime = clock
      }
    } else if (this.lastS < 60 && s > L - 60 && this.crossings >= 0 && !this.halfway) {
      // Сдал назад через линию — круг не засчитываем дважды
      this.crossings--
    }
    this.lastS = s
    return lapTime
  }
}

/** Водитель-бот: держит выбранную полосу, обгоняет, тормозит перед поворотами */
export class BotDriver {
  private lane: number
  private laneTarget: number
  private stuck = 0
  private laneTimer = 0

  constructor(
    private track: Track,
    readonly profile: BotProfile,
    lane: number,
  ) {
    this.lane = lane
    this.laneTarget = lane
  }

  drive(me: CarPhysics, others: CarPhysics[], dt: number, catchUp: number): Controls {
    const t = this.track
    const L = t.length
    const s = ((me.trackS % L) + L) % L
    const speed = me.speed

    /* Выбор полосы: обгон машины впереди, объезд разделителя */
    this.laneTimer -= dt
    for (const o of others) {
      let ds = o.trackS - me.trackS
      if (ds < -L / 2) ds += L
      if (ds > L / 2) ds -= L
      if (ds > 0 && ds < 10 + speed * 0.5 && Math.abs(o.lateral - this.lane) < 2.4 && this.laneTimer <= 0) {
        const left = this.lane + 3.6
        const right = this.lane - 3.6
        this.laneTarget = Math.abs(left) < HALF_WIDTH - 2 && (Math.abs(right) >= HALF_WIDTH - 2 || Math.random() < 0.5) ? left : right
        this.laneTimer = 2
      }
    }
    for (const d of DIVIDERS) {
      if (s > d.from - 80 && s < d.to + 5) {
        // Перед разделителем остаёмся на своей стороне
        const side = me.lateral >= 0 ? 1 : -1
        if (Math.abs(this.laneTarget) < DIVIDER_HALF + 2.2 || Math.sign(this.laneTarget) !== side) this.laneTarget = side * 4
      }
    }
    for (const g of GANTRIES) {
      if (Math.abs(s - g) < 40) this.laneTarget = Math.max(-5, Math.min(5, this.laneTarget))
    }
    this.laneTarget = Math.max(-(HALF_WIDTH - 2), Math.min(HALF_WIDTH - 2, this.laneTarget))
    this.lane += (this.laneTarget - this.lane) * Math.min(1, dt * 1.2)

    /* Руль: на точку впереди по своей полосе */
    const look = 7 + speed * 0.45
    const target = t.sample(s + look, this.lane)
    const dx = target.x - me.x
    const dz = target.z - me.z
    const fx = Math.sin(me.heading)
    const fz = Math.cos(me.heading)
    const along = dx * fx + dz * fz
    const side = dx * fz - dz * fx
    const angle = Math.atan2(side, along)
    const steer = Math.max(-1, Math.min(1, angle * 2.6 - me.yawRate * 0.08))

    /* Скорость: смотрим кривизну на тормозной путь вперёд */
    const aLat = 21 * this.profile.skill * catchUp
    let vMax = 90
    const horizon = 20 + speed * speed / 22
    for (let d = 8; d < horizon; d += 6) {
      const k = Math.abs(t.at(Math.floor(s + d)).curvature)
      if (k < 1e-4) continue
      const vCorner = Math.sqrt(aLat / k)
      // Сколько можно ехать сейчас, чтобы успеть сбросить до vCorner на дистанции d
      const vNow = Math.sqrt(vCorner * vCorner + 2 * 24 * this.profile.skill * Math.max(0, d - 6))
      vMax = Math.min(vMax, vNow)
    }
    let throttle = 1
    let brake = 0
    if (speed > vMax + 0.5) {
      throttle = 0
      brake = Math.min(1, (speed - vMax) / 5)
    } else if (speed > vMax - 2) {
      throttle = 0.4
    }
    // Скорость на прямых тоже зависит от мастерства: слабые боты не выжимают максимум
    throttle *= Math.min(1.05, catchUp) * (0.86 + this.profile.skill * 0.14)
    const straight = vMax > 70 && Math.abs(steer) < 0.15
    const nitro = straight && this.profile.skill > 0.9 && me.nitro > 0.4 && Math.random() < 0.6

    /* Застрял — разворачиваем на трассу */
    if (speed < 2 && throttle > 0) this.stuck += dt
    else this.stuck = 0
    if (this.stuck > 2.5) {
      me.place(me.trackS)
      this.stuck = 0
    }

    return { throttle, brake, steer, handbrake: false, nitro }
  }
}
