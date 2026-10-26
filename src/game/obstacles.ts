import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu'
import { color, float, lights, mix, positionLocal, step, fract, abs, attribute } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { HALF_WIDTH, Track } from './track'
import { DIVIDERS, DIVIDER_HALF, GANTRIES, inTunnel, bridgeCrossings } from './features'
import type { CarPhysics } from './physics'
import { rng } from './world'

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any

/** Машина для столкновений — два круга вдоль кузова */
const CAR_R = 0.95
const CAR_OFF = 1.3

interface Solid {
  x: number
  z: number
  r: number
  s: number
}

interface Breakable {
  index: number
  x: number
  z: number
  s: number
  down: boolean
  pos: Vector3
  vel: Vector3
  axis: Vector3
  tilt: number
  tiltVel: number
  yaw: number
}

export interface Hit {
  impact: number
  /** Точка удара для искр */
  x: number
  z: number
  solid: boolean
}

const BUCKET = 20

export class Obstacles {
  readonly group = new Group()
  private solids: Solid[] = []
  private breakables: Breakable[] = []
  private buckets = new Map<number, Array<Solid | Breakable>>()
  private postMesh!: InstancedMesh
  private m = new Matrix4()
  private q = new Quaternion()
  private qy = new Quaternion()
  private one = new Vector3(1, 1, 1)
  private up = new Vector3(0, 1, 0)

  constructor(private track: Track) {
    const rand = rng(4242)
    const L = track.length
    const bridges = bridgeCrossings(track)
    const nearBridge = (s: number) => bridges.some((b) => Math.abs(((s - b + L * 1.5) % L) - L / 2) < 40)

    /* Несносимые: опоры порталов и тумбы на концах разделителей */
    const columnGeos: BufferGeometry[] = []
    const beamGeos: BufferGeometry[] = []
    for (const s of GANTRIES) {
      const p = track.sample(s)
      const yaw = Math.atan2(p.tx, p.tz)
      for (const side of [-1, 1]) {
        const q = track.sample(s, side * (HALF_WIDTH - 0.7))
        this.addSolid(q.x, q.z, 0.55, s)
        columnGeos.push(new CylinderGeometry(0.5, 0.6, 7.2, 16).translate(q.x, 3.6, q.z))
        columnGeos.push(new CylinderGeometry(0.75, 0.75, 0.6, 16).translate(q.x, 0.3, q.z))
      }
      const beam = new BoxGeometry(HALF_WIDTH * 2 - 0.4, 0.9, 0.9)
      beam.rotateY(yaw)
      beam.translate(p.x, 7.4, p.z)
      beamGeos.push(beam)
    }
    for (const d of DIVIDERS) {
      for (const s of [d.from - 0.6, d.to + 0.6]) {
        const p = track.sample(s)
        this.addSolid(p.x, p.z, 0.5, s)
        columnGeos.push(new CylinderGeometry(0.45, 0.5, 1.1, 16).translate(p.x, 0.55, p.z))
      }
    }
    const concrete = new MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.2 })
    {
      // Жёлто-чёрные косые полосы внизу, выше — тёмный бетон
      const p = positionLocal as N
      const stripes = step(0.5, fract(p.y.mul(1.6).add(p.x.add(p.z).mul(0.8))))
      const low = step(p.y, 1.15)
      concrete.colorNode = mix(color('#1b1b22'), mix(color('#111114'), color('#f2c400'), stripes), low)
      concrete.emissiveNode = color('#f2c400').mul(stripes).mul(low).mul(0.25)
    }
    concrete.lightsNode = lights([])
    this.group.add(new Mesh(mergeGeometries(columnGeos), concrete))

    const beamMat = new MeshStandardNodeMaterial({ color: '#16161d', roughness: 0.4, metalness: 0.7 })
    beamMat.lightsNode = lights([])
    beamMat.emissiveNode = color('#2bf0ff').mul(step(0.38, abs((positionLocal as N).y.sub(7.4))).mul(3))
    this.group.add(new Mesh(mergeGeometries(beamGeos), beamMat))

    /* Сносимые: тонкие столбики с указателями на внутренней стороне поворотов */
    let last = -100
    for (let i = 0; i < track.count; i += 3) {
      const pt = track.at(i)
      if (Math.abs(pt.curvature) < 1 / 130) continue
      if (i - last < 9) continue
      if (inTunnel(i, L, 10) || nearBridge(i)) continue
      last = i
      const side = Math.sign(pt.curvature)
      const p = track.sample(i, side * (HALF_WIDTH - 0.8))
      const b: Breakable = {
        index: this.breakables.length,
        x: p.x,
        z: p.z,
        s: i,
        down: false,
        pos: new Vector3(p.x, 0, p.z),
        vel: new Vector3(),
        axis: new Vector3(1, 0, 0),
        tilt: 0,
        tiltVel: 0,
        yaw: Math.atan2(p.tx, p.tz) + (rand() - 0.5) * 0.2,
      }
      this.breakables.push(b)
      this.bucket(b.s).push(b)
    }
    const postGeo = mergeGeometries([
      new CylinderGeometry(0.06, 0.07, 2.6, 8).translate(0, 1.3, 0),
      new BoxGeometry(0.7, 0.7, 0.04).translate(0, 2.75, 0),
    ])
    const postMat = new MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.6 })
    {
      const p = positionLocal as N
      const plate = step(2.38, p.y)
      const kind = attribute('aKind', 'float') as N
      const plateCol = mix(color('#1e6bff'), color('#ff2b4f'), kind)
      postMat.colorNode = mix(color('#9aa0ad'), plateCol, plate)
      // Световозвращающая полоса на столбике и светящаяся табличка
      const band = step(abs(p.y.sub(1.9)), 0.1).mul(float(1).sub(plate))
      postMat.emissiveNode = plateCol.mul(plate).mul(1.4).add(color('#ffffff').mul(band).mul(1.5))
    }
    postMat.lightsNode = lights([])
    this.postMesh = new InstancedMesh(postGeo, postMat, Math.max(1, this.breakables.length))
    this.postMesh.instanceMatrix.setUsage(DynamicDrawUsage)
    const kinds = new Float32Array(Math.max(1, this.breakables.length))
    this.breakables.forEach((b, i) => {
      kinds[i] = rand() < 0.5 ? 1 : 0
      this.writePost(b)
    })
    postGeo.setAttribute('aKind', new InstancedBufferAttribute(kinds, 1))
    this.group.add(this.postMesh)
  }

  private addSolid(x: number, z: number, r: number, s: number) {
    const o = { x, z, r, s }
    this.solids.push(o)
    this.bucket(s).push(o)
  }

  private bucket(s: number) {
    const L = this.track.length
    const k = Math.floor((((s % L) + L) % L) / BUCKET)
    let list = this.buckets.get(k)
    if (!list) {
      list = []
      this.buckets.set(k, list)
    }
    return list
  }

  private near(s: number) {
    const L = this.track.length
    const n = Math.ceil(L / BUCKET)
    const k = Math.floor((((s % L) + L) % L) / BUCKET)
    const out: Array<Solid | Breakable> = []
    for (const dk of [-1, 0, 1]) {
      const list = this.buckets.get((k + dk + n) % n)
      if (list) out.push(...list)
    }
    return out
  }

  private writePost(b: Breakable) {
    this.qy.setFromAxisAngle(this.up, b.yaw)
    this.q.setFromAxisAngle(b.axis, b.tilt).multiply(this.qy)
    this.m.compose(b.pos, this.q, this.one)
    this.postMesh.setMatrixAt(b.index, this.m)
  }

  /** Разделители и столбы для одной машины. Возвращает самый сильный удар за шаг. */
  collide(car: CarPhysics): Hit | null {
    let hit: Hit | null = null
    const L = this.track.length
    const s = ((car.trackS % L) + L) % L

    // Разделитель: бетонный барьер по оси дороги
    for (const d of DIVIDERS) {
      if (s < d.from - 0.4 || s > d.to + 0.4) continue
      const limit = DIVIDER_HALF + 1.0
      if (Math.abs(car.lateral) >= limit) continue
      const pt = this.track.at(car.trackIndex)
      const side = car.lateral >= 0 ? 1 : -1
      const push = limit - Math.abs(car.lateral)
      car.x += pt.nx * side * push
      car.z += pt.nz * side * push
      car.lateral = side * limit
      const vn = -(car.vx * pt.nx + car.vz * pt.nz) * side
      if (vn > 0) {
        car.vx += pt.nx * side * vn * 1.2
        car.vz += pt.nz * side * vn * 1.2
        if (!hit || vn > hit.impact) hit = { impact: vn, x: car.x - pt.nx * side, z: car.z - pt.nz * side, solid: true }
      }
    }

    const fx = Math.sin(car.heading)
    const fz = Math.cos(car.heading)
    for (const o of this.near(s)) {
      const isPost = 'index' in o
      if (isPost && (o as Breakable).down) continue
      const r = isPost ? 0.12 : (o as Solid).r
      for (const off of [CAR_OFF, -CAR_OFF]) {
        const cx = car.x + fx * off
        const cz = car.z + fz * off
        const dx = cx - o.x
        const dz = cz - o.z
        const d = Math.hypot(dx, dz)
        if (d >= r + CAR_R || d < 1e-4) continue
        const nx = dx / d
        const nz = dz / d
        const vn = -(car.vx * nx + car.vz * nz)
        if (isPost) {
          // Столбик ломается и отлетает, машина почти не теряет скорость
          const b = o as Breakable
          b.down = true
          b.vel.set(car.vx * 0.8 - nx * 2, 2.5 + Math.random() * 2, car.vz * 0.8 - nz * 2)
          b.axis.set(car.vz, 0, -car.vx).normalize()
          b.tiltVel = 3 + Math.random() * 4
          car.vx *= 0.95
          car.vz *= 0.95
          if (!hit) hit = { impact: Math.max(1.2, vn * 0.15), x: o.x, z: o.z, solid: false }
          break
        }
        const pen = r + CAR_R - d
        car.x += nx * pen
        car.z += nz * pen
        if (vn > 0) {
          car.vx += nx * vn * 1.25
          car.vz += nz * vn * 1.25
          car.vx *= 0.9
          car.vz *= 0.9
          car.yawRate += (off > 0 ? 1 : -1) * (nx * fz - nz * fx) * vn * 0.12
          if (!hit || vn > hit.impact) hit = { impact: vn, x: o.x + nx * r, z: o.z + nz * r, solid: true }
        }
      }
    }
    return hit
  }

  /** Анимация сбитых столбиков */
  update(dt: number) {
    let dirty = false
    for (const b of this.breakables) {
      if (!b.down || (b.tilt >= Math.PI / 2 - 0.01 && b.vel.lengthSq() < 0.01)) continue
      dirty = true
      b.vel.y -= 9.8 * dt
      b.pos.addScaledVector(b.vel, dt)
      b.tilt = Math.min(Math.PI / 2, b.tilt + b.tiltVel * dt)
      if (b.pos.y <= 0) {
        b.pos.y = 0
        b.vel.y = Math.abs(b.vel.y) * 0.2
        b.vel.x *= 0.7
        b.vel.z *= 0.7
        if (b.vel.lengthSq() < 0.05) b.vel.set(0, 0, 0)
      }
      this.writePost(b)
    }
    if (dirty) this.postMesh.instanceMatrix.needsUpdate = true
  }

  /** Новый заезд: столбики снова стоят */
  reset() {
    for (const b of this.breakables) {
      b.down = false
      b.tilt = 0
      b.tiltVel = 0
      b.vel.set(0, 0, 0)
      b.pos.set(b.x, 0, b.z)
      this.writePost(b)
    }
    this.postMesh.instanceMatrix.needsUpdate = true
  }
}
