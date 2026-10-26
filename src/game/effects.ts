import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Quaternion,
  Scene,
  Texture,
  Vector3,
  Camera,
  DynamicDrawUsage,
  PointLight,
} from 'three/webgpu'
import {
  attribute,
  float,
  hash,
  instanceIndex,
  mod,
  positionLocal,
  texture,
  time,
  uniform,
  uv,
  vec3,
  vec4,
  smoothstep,
  step,
  vec2,
} from 'three/tsl'

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any

/** Дождь целиком на GPU: позиции капель считаются из номера экземпляра и времени */
export function createRain(scene: Scene, count: number, dry?: { texture: Texture; minX: number; minZ: number; size: number; height: number }) {
  const center = uniform(new Vector3())
  const wind = uniform(new Vector3(0, 0, 0))
  const amount = uniform(1)
  const geo = new BoxGeometry(0.012, 0.75, 0.012)
  const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending })
  const box = vec3(70, 40, 70)
  const i = float(instanceIndex) as N
  const seed = vec3(hash(i), hash(i.add(17.31)), hash(i.add(41.7)))
  const fall = time.mul(float(22).add(hash(i.add(5.1)).mul(8)))
  let p: N = seed.mul(box)
  p = vec3(p.x, p.y.sub(fall), p.z)
  // Повторяем куб дождя вокруг камеры
  const rel = mod(p.sub(center).add(box.mul(0.5)), box).sub(box.mul(0.5))
  const world = center.add(rel)
  // Капли наклонены по движению машины, чтобы чувствовалась скорость
  const local = positionLocal as N
  const slant = wind.mul(local.y.mul(0.05))
  mat.positionNode = world.add(local).add(slant)
  let fade: N = smoothstep(35, 8, rel.length())
  if (dry) {
    // Под сводом тоннеля капель нет
    const muv = world.xz.sub(vec2(dry.minX, dry.minZ)).div(dry.size)
    const inBox = step(0, muv.x).mul(step(muv.x, 1)).mul(step(0, muv.y)).mul(step(muv.y, 1))
    const covered = texture(dry.texture, muv).r.mul(inBox).mul(step(world.y, dry.height + 2))
    fade = fade.mul(float(1).sub(smoothstep(0.3, 0.6, covered)))
  }
  mat.colorNode = vec3(0.55, 0.65, 0.85).mul(fade).mul(0.55).mul(amount)
  const mesh = new InstancedMesh(geo, mat, count)
  mesh.frustumCulled = false
  scene.add(mesh)
  return { mesh, center, wind, amount }
}

interface Particle {
  alive: boolean
  pos: Vector3
  vel: Vector3
  life: number
  max: number
  size: number
  grow: number
  color: Color
  gravity: number
  drag: number
}

/** Брызги из-под колёс, дым при заносе, искры при ударе — общий пул спрайтов */
export class Particles {
  private mesh: InstancedMesh
  private items: Particle[] = []
  private colors: InstancedBufferAttribute
  private alphas: InstancedBufferAttribute
  private next = 0
  private m = new Matrix4()
  private q = new Quaternion()
  private s = new Vector3()

  constructor(scene: Scene, sprite: Texture, private capacity = 1400) {
    const geo = new PlaneGeometry(1, 1)
    const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending })
    const tint = attribute('aColor', 'vec3') as N
    const alpha = attribute('aAlpha', 'float') as N
    mat.colorNode = vec4(tint.mul(texture(sprite, uv()).r).mul(alpha), 1)
    this.mesh = new InstancedMesh(geo, mat, capacity)
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.colors = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.alphas = new InstancedBufferAttribute(new Float32Array(capacity), 1)
    this.colors.setUsage(DynamicDrawUsage)
    this.alphas.setUsage(DynamicDrawUsage)
    geo.setAttribute('aColor', this.colors)
    geo.setAttribute('aAlpha', this.alphas)
    for (let i = 0; i < capacity; i++) {
      this.items.push({
        alive: false,
        pos: new Vector3(),
        vel: new Vector3(),
        life: 0,
        max: 1,
        size: 1,
        grow: 0,
        color: new Color(),
        gravity: 0,
        drag: 0,
      })
      this.m.makeScale(0, 0, 0)
      this.mesh.setMatrixAt(i, this.m)
    }
    scene.add(this.mesh)
  }

  emit(o: { pos: Vector3; vel: Vector3; life: number; size: number; grow: number; color: Color; gravity?: number; drag?: number }) {
    const p = this.items[this.next]
    this.next = (this.next + 1) % this.capacity
    p.alive = true
    p.pos.copy(o.pos)
    p.vel.copy(o.vel)
    p.life = 0
    p.max = o.life
    p.size = o.size
    p.grow = o.grow
    p.color.copy(o.color)
    p.gravity = o.gravity ?? 0
    p.drag = o.drag ?? 1.5
  }

  update(dt: number, camera: Camera) {
    this.q.copy(camera.quaternion)
    const cols = this.colors.array as Float32Array
    const alph = this.alphas.array as Float32Array
    for (let i = 0; i < this.capacity; i++) {
      const p = this.items[i]
      if (!p.alive) continue
      p.life += dt
      if (p.life >= p.max) {
        p.alive = false
        this.m.makeScale(0, 0, 0)
        this.mesh.setMatrixAt(i, this.m)
        alph[i] = 0
        continue
      }
      p.vel.y -= p.gravity * dt
      p.vel.multiplyScalar(Math.exp(-p.drag * dt))
      p.pos.addScaledVector(p.vel, dt)
      if (p.pos.y < 0.02) {
        p.pos.y = 0.02
        p.vel.y *= -0.3
      }
      const t = p.life / p.max
      const size = p.size + p.grow * t
      this.s.set(size, size, size)
      this.m.compose(p.pos, this.q, this.s)
      this.mesh.setMatrixAt(i, this.m)
      cols[i * 3] = p.color.r
      cols[i * 3 + 1] = p.color.g
      cols[i * 3 + 2] = p.color.b
      alph[i] = Math.sin(Math.PI * Math.min(1, t * 1.2)) * (1 - t)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    this.colors.needsUpdate = true
    this.alphas.needsUpdate = true
  }
}

/** Пул из нескольких точечных источников, которые «переезжают» к ближайшим к машине фонарям */
export function attachLampLights(lights: PointLight[], lampPositions: Vector3[], lampColors: Color[]) {
  // Без аллокаций в кадре: держим индексы и квадраты расстояний ближайших в фиксированных массивах
  const n = lights.length
  const idx = new Int32Array(n)
  const dist = new Float64Array(n)
  return (x: number, z: number) => {
    idx.fill(-1)
    dist.fill(Infinity)
    for (let i = 0; i < lampPositions.length; i++) {
      const p = lampPositions[i]
      const d = (p.x - x) ** 2 + (p.z - z) ** 2
      if (d >= 70 * 70 || d >= dist[n - 1]) continue
      let k = n - 1
      while (k > 0 && dist[k - 1] > d) {
        dist[k] = dist[k - 1]
        idx[k] = idx[k - 1]
        k--
      }
      dist[k] = d
      idx[k] = i
    }
    for (let k = 0; k < n; k++) {
      const l = lights[k]
      if (idx[k] < 0) {
        l.intensity = 0
        continue
      }
      l.position.copy(lampPositions[idx[k]])
      l.color.copy(lampColors[idx[k]])
      l.intensity = 70 * Math.max(0, 1 - Math.sqrt(dist[k]) / 40)
    }
  }
}
