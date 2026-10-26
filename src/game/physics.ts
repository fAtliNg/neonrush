import { HALF_WIDTH, Track } from './track'
import type { Controls } from './input'

/** Скорости переключения передач, м/с */
const GEARS = [0, 15, 27, 39, 51, 64, 92]
const TOP_SPEED = 75 // ≈ 270 км/ч без нитро
const NITRO_SPEED = 88 // ≈ 317 км/ч
const WALL = HALF_WIDTH + 0.5 - 1.0

export interface CarEvents {
  impact: number
}

export class CarPhysics {
  x = 0
  z = 0
  heading = 0
  vx = 0
  vz = 0
  yawRate = 0
  steerAngle = 0
  nitro = 1
  nitroActive = false
  gear = 1
  rpm = 1000
  shiftTimer = 0
  drifting = false
  slip = 0
  speed = 0
  forwardSpeed = 0
  latAccel = 0
  longAccel = 0
  wheelSpin = 0
  trackIndex = -1
  trackS = 0
  lateral = 0
  throttle = 0
  braking = 0

  constructor(private track: Track) {}

  place(s: number) {
    const p = this.track.sample(s)
    this.x = p.x
    this.z = p.z
    this.heading = Math.atan2(p.tx, p.tz)
    this.vx = this.vz = this.yawRate = 0
    this.gear = 1
    this.trackIndex = -1
  }

  step(dt: number, c: Controls): CarEvents {
    const ev: CarEvents = { impact: 0 }
    const fx = Math.sin(this.heading)
    const fz = Math.cos(this.heading)
    const rx = -fz
    const rz = fx
    let vLong = this.vx * fx + this.vz * fz
    let vLat = this.vx * rx + this.vz * rz
    const speed = Math.hypot(vLong, vLat)
    const prevLong = vLong

    /* Нитро */
    this.nitroActive = c.nitro && this.nitro > 0.02 && c.throttle > 0.1
    if (this.nitroActive) this.nitro = Math.max(0, this.nitro - dt * 0.22)
    else this.nitro = Math.min(1, this.nitro + dt * (0.035 + (this.drifting ? 0.16 : 0)))

    /* Продольная динамика */
    if (this.shiftTimer > 0) this.shiftTimer -= dt
    const top = this.nitroActive ? NITRO_SPEED : TOP_SPEED
    const torque = this.shiftTimer > 0 ? 0.25 : 1
    if (c.throttle > 0 && vLong > -1) {
      const k = Math.max(0, 1 - (vLong / top) ** 2)
      vLong += c.throttle * (11 + 6 * k) * k * torque * dt
      if (this.nitroActive) vLong += 9 * dt
    }
    if (c.brake > 0) {
      if (vLong > 0.5) vLong -= c.brake * 30 * dt
      else vLong = Math.max(-14, vLong - c.brake * 7 * dt)
    }
    if (c.handbrake) vLong -= Math.sign(vLong) * Math.min(Math.abs(vLong), 5 * dt)
    // Сопротивление воздуха и качению
    vLong -= vLong * Math.abs(vLong) * 0.00045 * dt + Math.sign(vLong) * Math.min(Math.abs(vLong), 0.6 * dt)
    if (c.throttle === 0 && c.brake === 0) vLong -= Math.sign(vLong) * Math.min(Math.abs(vLong), 1.2 * dt)

    /* Занос */
    const slipAngle = Math.atan2(vLat, Math.max(Math.abs(vLong), 1))
    if (c.handbrake && speed > 12) this.drifting = true
    else if (this.drifting && (Math.abs(slipAngle) < 0.15 || speed < 8)) this.drifting = false
    // Без ручника машину срывает в занос только при очень большом угле скольжения
    else if (!this.drifting && Math.abs(slipAngle) > 0.6 && speed > 22) this.drifting = true

    const grip = this.drifting ? (c.handbrake ? 2.2 : 4.5) : 14
    const latBefore = vLat
    vLat *= Math.exp(-grip * dt)
    // В заносе часть боковой скорости переходит в продольную: машина «выстреливает» из поворота
    if (this.drifting) vLong += Math.abs(latBefore - vLat) * 0.2 * Math.sign(vLong || 1)

    /* Руление */
    const steerLimit = 0.6 - 0.4 * Math.min(1, speed / 70)
    this.steerAngle = c.steer * (this.drifting ? Math.min(0.6, steerLimit * 1.6) : steerLimit)
    let desiredYaw = (vLong * Math.tan(this.steerAngle)) / 2.6
    if (this.drifting) {
      // Помощник заноса: руль доворачивает, а угол скольжения сам тянется к ~25°, чтобы машину не крутило
      desiredYaw = desiredYaw * 1.05 + c.steer * 0.15 * Math.min(1, speed / 25) - slipAngle * 3.2
    }
    // Аркадный предел сцепления ~2,7g: машина поворачивает резко, но на скорости её не срывает
    const maxYaw = (this.drifting ? 34 : 27) / Math.max(speed, 6)
    desiredYaw = Math.max(-maxYaw, Math.min(maxYaw, desiredYaw))
    const yawResp = this.drifting ? 4.5 : 14
    this.yawRate += (desiredYaw - this.yawRate) * Math.min(1, yawResp * dt)
    if (speed < 0.5) this.yawRate *= 0.8

    this.heading += this.yawRate * dt

    this.vx = fx * vLong + rx * vLat
    this.vz = fz * vLong + rz * vLat
    this.x += this.vx * dt
    this.z += this.vz * dt

    /* Стены */
    const near = this.track.nearest(this.x, this.z, this.trackIndex)
    this.trackIndex = near.index
    this.trackS = near.s
    this.lateral = near.lateral
    const over = Math.abs(near.lateral) - WALL
    if (over > 0) {
      const sgn = Math.sign(near.lateral)
      const nx = near.point.nx * sgn
      const nz = near.point.nz * sgn
      this.x -= nx * over
      this.z -= nz * over
      const vn = this.vx * nx + this.vz * nz
      if (vn > 0) {
        ev.impact = vn
        // Касательный удар почти не гасит скорость, лобовой — сильно
        this.vx -= nx * vn * 1.2
        this.vz -= nz * vn * 1.2
        this.vx *= 0.985
        this.vz *= 0.985
        // Удар разворачивает машину вдоль стены
        const tx = near.point.tx
        const tz = near.point.tz
        const along = this.vx * tx + this.vz * tz
        const target = Math.atan2(tx * Math.sign(along || 1), tz * Math.sign(along || 1))
        let d = target - this.heading
        d = Math.atan2(Math.sin(d), Math.cos(d))
        this.yawRate += d * Math.min(1, vn * 0.25)
      }
    }

    /* Передачи и обороты для звука и HUD */
    const fwd = Math.max(0, vLong)
    if (vLong < -0.5) this.gear = 0
    else if (this.gear === 0) this.gear = 1
    if (this.gear > 0) {
      if (this.gear < GEARS.length - 1 && fwd > GEARS[this.gear] * 0.98 && c.throttle > 0) {
        this.gear++
        this.shiftTimer = 0.16
      } else if (this.gear > 1 && fwd < GEARS[this.gear - 1] * 0.72) this.gear--
    }
    const lo = this.gear <= 1 ? 0 : GEARS[this.gear - 1] * 0.62
    const hi = GEARS[Math.max(1, this.gear)]
    const tRpm = this.gear === 0 ? 1200 + Math.abs(vLong) * 300 : 1000 + Math.max(0, (fwd - lo) / (hi - lo)) * 6800
    const freeRev = c.throttle > 0 && (this.drifting || speed < 3) ? 1500 * c.throttle : 0
    this.rpm += (Math.min(8200, tRpm + freeRev) - this.rpm) * Math.min(1, 12 * dt)

    this.speed = speed
    this.forwardSpeed = vLong
    this.slip = Math.abs(slipAngle)
    this.latAccel = vLong * this.yawRate
    this.longAccel = (vLong - prevLong) / dt
    this.wheelSpin += (vLong / 0.36) * dt
    this.throttle = c.throttle
    this.braking = c.brake > 0 && vLong > 0.5 ? 1 : 0
    return ev
  }
}
