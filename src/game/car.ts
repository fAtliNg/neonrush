import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  AdditiveBlending,
  PointLight,
  Texture,
  TorusGeometry,
} from 'three/webgpu'
import {
  abs,
  color,
  float,
  mix,
  mx_noise_float,
  normalLocal,
  positionLocal,
  smoothstep,
  step,
  time,
  uniform,
  uv,
  vec3,
  lights,
  max,
  pow,
  hash,
  floor,
  dot,
} from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any

export const WHEEL_RADIUS = 0.36
const WHEELBASE_HALF = 1.38
const TRACK_HALF = 0.83

/** Гладкая интерполяция по ключам (Catmull-Rom в 1D) */
function curve(keys: Array<[number, number]>) {
  return (x: number) => {
    if (x <= keys[0][0]) return keys[0][1]
    if (x >= keys[keys.length - 1][0]) return keys[keys.length - 1][1]
    let i = 0
    while (keys[i + 1][0] < x) i++
    const p0 = keys[Math.max(0, i - 1)][1]
    const p1 = keys[i][1]
    const p2 = keys[i + 1][1]
    const p3 = keys[Math.min(keys.length - 1, i + 2)][1]
    const t = (x - keys[i][0]) / (keys[i + 1][0] - keys[i][0])
    const t2 = t * t
    const t3 = t2 * t
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  }
}

interface Section {
  z: number
  w: number
  bottom: number
  top: number
  taper: number
  exp: number
}

/** Лофт по сечениям-суперэллипсам с заглушками на концах */
function loft(sections: Section[], segs = 40) {
  const pos: number[] = []
  const uvs: number[] = []
  const idx: number[] = []
  sections.forEach((s, si) => {
    const mid = (s.bottom + s.top) / 2
    const hh = (s.top - s.bottom) / 2
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2
      const c = Math.cos(a)
      const sn = Math.sin(a)
      const e = 2 / s.exp
      let x = s.w * Math.sign(c) * Math.abs(c) ** e
      const yN = Math.sign(sn) * Math.abs(sn) ** e
      x *= 1 - s.taper * Math.max(0, yN)
      pos.push(x, mid + hh * yN, s.z)
      uvs.push(j / segs, si / (sections.length - 1))
    }
  })
  const row = segs + 1
  for (let i = 0; i < sections.length - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * row + j
      const b = a + row
      idx.push(a, a + 1, b, a + 1, b + 1, b)
    }
  }
  // Заглушки
  for (const [si, flip] of [
    [0, true],
    [sections.length - 1, false],
  ] as const) {
    const s = sections[si]
    const center = pos.length / 3
    pos.push(0, (s.bottom + s.top) / 2, s.z)
    uvs.push(0.5, si ? 1 : 0)
    for (let j = 0; j < segs; j++) {
      const a = si * row + j
      if (flip) idx.push(center, a + 1, a)
      else idx.push(center, a, a + 1)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

function bodySections(): Section[] {
  const width = curve([
    [-2.3, 0.78],
    [-2.0, 0.92],
    [-1.4, 0.99],
    [-0.4, 0.95],
    [0.6, 0.94],
    [1.4, 0.97],
    [2.0, 0.86],
    [2.3, 0.62],
  ])
  const top = curve([
    [-2.3, 0.86],
    [-2.05, 0.98],
    [-1.4, 0.97],
    [-0.8, 0.92],
    [0.6, 0.86],
    [1.5, 0.8],
    [2.05, 0.7],
    [2.3, 0.52],
  ])
  const sections: Section[] = []
  const n = 72
  for (let i = 0; i <= n; i++) {
    const z = -2.32 + (4.64 * i) / n
    let bottom = 0.27
    for (const az of [-WHEELBASE_HALF, WHEELBASE_HALF]) {
      const dz = z - az
      const r = 0.47
      if (Math.abs(dz) < r) bottom = Math.max(bottom, WHEEL_RADIUS + Math.sqrt(r * r - dz * dz) - 0.02)
    }
    let w = width(z)
    let t = top(z)
    // Скругление носа и кормы
    const end = Math.max(0, Math.abs(z) - 2.1) / 0.22
    const k = Math.sqrt(Math.max(0, 1 - end * end))
    w *= 0.55 + 0.45 * k
    const mid = (bottom + t) / 2
    t = mid + (t - mid) * (0.45 + 0.55 * k)
    bottom = mid - (mid - bottom) * (0.45 + 0.55 * k)
    sections.push({ z, w, bottom, top: t, taper: 0.1, exp: 5 })
  }
  return sections
}

function cabinSections(): Section[] {
  const roof = curve([
    [-1.32, 0.9],
    [-0.95, 1.06],
    [-0.45, 1.2],
    [0.05, 1.21],
    [0.45, 1.08],
    [0.95, 0.84],
  ])
  const width = curve([
    [-1.32, 0.66],
    [-0.6, 0.79],
    [0.2, 0.8],
    [0.95, 0.74],
  ])
  const s: Section[] = []
  const n = 40
  for (let i = 0; i <= n; i++) {
    const z = -1.32 + (2.27 * i) / n
    s.push({ z, w: width(z), bottom: 0.6, top: roof(z), taper: 0.32, exp: 4 })
  }
  return s
}

export interface CarRig {
  root: Group
  body: Group
  wheels: Array<{ steer: Group; spin: Group; front: boolean; side: number }>
  flames: Mesh[]
  uniforms: { brake: N; nitro: N; reverse: N }
  pointLights: PointLight[]
  headlightPositions: Array<[number, number, number]>
}

export interface CarLivery {
  /** Низ и верх кузова — градиент краски */
  low: string
  high: string
  stripe: string
  /** Цвет неона под днищем */
  glow: string
  /** Сколько фонарей подсвечивают кузов: у игрока больше */
  lights?: number
}

export const PLAYER_LIVERY: CarLivery = { low: '#4a0590', high: '#9d10e0', stripe: '#25f2ff', glow: '#2bf0ff', lights: 4 }

export function buildCar(envMap: Texture, livery: CarLivery = PLAYER_LIVERY): CarRig {
  const root = new Group()
  const body = new Group()
  root.add(body)

  const brake = uniform(0)
  const nitro = uniform(0)
  const reverse = uniform(0)

  // Настоящие точечные источники освещают только машину: подсвечивают кузов светом ближайших фонарей
  const pointLights: PointLight[] = []
  for (let i = 0; i < (livery.lights ?? 2); i++) {
    const l = new PointLight('#ffffff', 0, 26, 1.6)
    pointLights.push(l)
  }
  const carLights = lights(pointLights)

  /* Краска: глубокий фиолетовый металлик с лаком и двумя полосами */
  const paint = new MeshPhysicalNodeMaterial({
    metalness: 0.75,
    roughness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    envMap,
    envMapIntensity: 0.7,
  } as any)
  {
    const p = positionLocal as N
    const n = normalLocal as N
    const base = mix(color(livery.low), color(livery.high), smoothstep(0.2, 1.0, p.y))
    const stripe = step(abs(abs(p.x).sub(0.2)), 0.07).mul(smoothstep(0.35, 0.7, n.y))
    const flake = hash(dot(floor(p.mul(900)) as N, vec3(1, 57, 113)) as N).mul(0.12) as N
    paint.colorNode = mix(base.add(flake.mul(0.3)), color(livery.stripe), stripe.mul(0.92))
    paint.roughnessNode = float(0.32).sub(flake)
  }
  paint.lightsNode = carLights

  const glass = new MeshPhysicalNodeMaterial({
    metalness: 0.2,
    roughness: 0.04,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    envMap,
    envMapIntensity: 1.6,
  } as any)
  {
    const p = positionLocal as N
    const n = normalLocal as N
    // Крыша и стойки окрашены в цвет кузова, остальное — тонированное стекло
    const roofMask = smoothstep(0.82, 0.9, n.y).mul(step(-0.75, p.z)).mul(step(p.z, 0.3))
    const pillar = step(abs(p.z.add(0.28)), 0.07).mul(step(0.5, abs(n.x)))
    const isPaint = max(roofMask, pillar)
    glass.colorNode = mix(color('#020306'), color(livery.low), isPaint)
    glass.metalnessNode = mix(float(0.2), float(0.65), isPaint)
    glass.roughnessNode = mix(float(0.03), float(0.3), isPaint)
  }
  glass.lightsNode = carLights

  const dark = new MeshStandardNodeMaterial({ color: '#08080b', roughness: 0.55, metalness: 0.3, envMap, envMapIntensity: 0.5 } as any)
  dark.lightsNode = carLights
  const carbon = new MeshStandardNodeMaterial({ color: '#111116', roughness: 0.25, metalness: 0.4, envMap } as any)
  {
    const g = uv().mul(60) as N
    carbon.colorNode = mix(color('#0b0b10'), color('#1b1b24'), step(0.5, abs(g.x.add(g.y).fract().sub(0.5)).mul(2)))
  }
  carbon.lightsNode = carLights

  const bodyMesh = new Mesh(loft(bodySections()), paint)
  const cabin = new Mesh(loft(cabinSections(), 32), glass)
  body.add(bodyMesh, cabin)

  // Шасси между колёсами, чтобы сквозь арки не было видно пустоты
  const chassis = new Mesh(new BoxGeometry(1.5, 0.42, 3.9), dark)
  chassis.position.set(0, 0.48, 0)
  body.add(chassis)

  // Передний сплиттер, решётка, диффузор
  const splitter = new Mesh(new BoxGeometry(1.7, 0.05, 0.4), carbon)
  splitter.position.set(0, 0.24, 2.12)
  const grille = new Mesh(new BoxGeometry(1.1, 0.16, 0.05), dark)
  grille.position.set(0, 0.4, 2.29)
  grille.rotation.x = -0.25
  const diffuser = new Mesh(new BoxGeometry(1.5, 0.16, 0.35), carbon)
  diffuser.position.set(0, 0.3, -2.15)
  body.add(splitter, grille, diffuser)

  // Антикрыло
  const wing = new Mesh(new BoxGeometry(1.78, 0.04, 0.34), carbon)
  wing.position.set(0, 1.2, -2.0)
  wing.rotation.x = 0.12
  const endplateGeo = new BoxGeometry(0.03, 0.16, 0.38)
  for (const s of [-1, 1]) {
    const ep = new Mesh(endplateGeo, carbon)
    ep.position.set(s * 0.89, 1.2, -2.0)
    const strut = new Mesh(new BoxGeometry(0.04, 0.26, 0.12), carbon)
    strut.position.set(s * 0.5, 1.06, -2.0)
    body.add(ep, strut)
  }
  body.add(wing)

  // Зеркала
  for (const s of [-1, 1]) {
    const mirror = new Mesh(new BoxGeometry(0.2, 0.09, 0.12), paint)
    mirror.position.set(s * 0.9, 0.98, 0.68)
    body.add(mirror)
  }

  /* Фары — узкие светящиеся щели */
  const headMat = new MeshBasicNodeMaterial()
  headMat.colorNode = color('#e8f4ff').mul(14)
  const drlMat = new MeshBasicNodeMaterial()
  drlMat.colorNode = color('#9ff6ff').mul(9)
  const headlightPositions: Array<[number, number, number]> = []
  for (const s of [-1, 1]) {
    const hl = new Mesh(new BoxGeometry(0.42, 0.07, 0.08), headMat)
    hl.position.set(s * 0.6, 0.66, 2.2)
    hl.rotation.y = s * -0.28
    hl.rotation.x = -0.35
    const drl = new Mesh(new BoxGeometry(0.46, 0.025, 0.06), drlMat)
    drl.position.set(s * 0.6, 0.715, 2.17)
    drl.rotation.y = s * -0.28
    body.add(hl, drl)
    headlightPositions.push([s * 0.6, 0.66, 2.3])
  }

  /* Задние фонари: сплошная полоса через всю корму */
  const tailMat = new MeshBasicNodeMaterial()
  tailMat.colorNode = mix(color('#ff1030').mul(float(4).add(brake.mul(12))), color('#ffffff').mul(8), reverse)
  const tail = new Mesh(new BoxGeometry(1.5, 0.05, 0.05), tailMat)
  tail.position.set(0, 0.86, -2.3)
  body.add(tail)
  for (const s of [-1, 1]) {
    const block = new Mesh(new BoxGeometry(0.3, 0.1, 0.05), tailMat)
    block.position.set(s * 0.62, 0.8, -2.28)
    body.add(block)
  }

  /* Неоновая подсветка днища */
  const underMat = new MeshBasicNodeMaterial()
  underMat.colorNode = color(livery.glow).mul(7)
  for (const s of [-1, 1]) {
    const strip = new Mesh(new BoxGeometry(0.04, 0.03, 2.6), underMat)
    strip.position.set(s * 0.74, 0.22, 0)
    body.add(strip)
  }

  /* Выхлоп и пламя нитро */
  const chrome = new MeshStandardNodeMaterial({ color: '#d9dde6', metalness: 1, roughness: 0.15, envMap } as any)
  chrome.lightsNode = carLights
  const flames: Mesh[] = []
  const flameMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide })
  {
    const v = uv().y as N
    const flick = mx_noise_float(vec3(uv().x.mul(6), v.mul(4).sub(time.mul(40)), 0)).mul(0.5).add(0.5)
    const core = mix(color('#ff6bf0'), color('#5cc8ff'), v)
    flameMat.colorNode = core.mul(pow(v, 1.5)).mul(flick.mul(6).add(2)).mul(nitro)
  }
  for (const s of [-1, 1]) {
    const tip = new Mesh(new CylinderGeometry(0.06, 0.06, 0.16, 16, 1, true), chrome)
    tip.rotation.x = Math.PI / 2
    tip.position.set(s * 0.42, 0.33, -2.3)
    body.add(tip)
    const flame = new Mesh(new ConeGeometry(0.09, 0.9, 16, 1, true), flameMat)
    flame.rotation.x = -Math.PI / 2
    flame.position.set(s * 0.42, 0.33, -2.8)
    flame.visible = false
    body.add(flame)
    flames.push(flame)
  }

  /* Колёса */
  const tireMat = new MeshStandardNodeMaterial({ color: '#0a0a0c', roughness: 0.8, metalness: 0 })
  tireMat.lightsNode = carLights
  const rimMat = new MeshPhysicalNodeMaterial({ color: new Color('#1d1f26'), metalness: 1, roughness: 0.22, clearcoat: 0.6, envMap } as any)
  rimMat.lightsNode = carLights
  const discMat = new MeshStandardNodeMaterial({ color: '#4a4a52', metalness: 0.9, roughness: 0.4, envMap } as any)
  discMat.lightsNode = carLights
  const caliperMat = new MeshStandardNodeMaterial({ color: '#ff2b4f', metalness: 0.3, roughness: 0.35, envMap } as any)
  caliperMat.lightsNode = carLights

  const tireGeo = mergeGeometries([
    new CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.27, 40, 1, true).rotateZ(Math.PI / 2),
    new TorusGeometry(WHEEL_RADIUS - 0.03, 0.04, 8, 40).rotateY(Math.PI / 2).translate(0.125, 0, 0),
    new TorusGeometry(WHEEL_RADIUS - 0.03, 0.04, 8, 40).rotateY(Math.PI / 2).translate(-0.125, 0, 0),
  ])
  const spokes: BufferGeometry[] = [new CylinderGeometry(0.075, 0.075, 0.06, 20).rotateZ(Math.PI / 2)]
  for (let i = 0; i < 10; i++) {
    const g = new BoxGeometry(0.035, 0.22, i % 2 ? 0.035 : 0.05).translate(0, 0.13, 0)
    g.rotateX((i / 10) * Math.PI * 2)
    spokes.push(g)
  }
  spokes.push(new TorusGeometry(0.255, 0.022, 6, 40).rotateY(Math.PI / 2))
  const rimGeo = mergeGeometries(spokes.map((g) => (g.index ? g.toNonIndexed() : g)))
  const discGeo = new CylinderGeometry(0.21, 0.21, 0.03, 32).rotateZ(Math.PI / 2)
  const caliperGeo = new BoxGeometry(0.06, 0.14, 0.12)

  const wheels: CarRig['wheels'] = []
  for (const front of [true, false]) {
    for (const side of [-1, 1]) {
      const steer = new Group()
      steer.position.set(side * TRACK_HALF, WHEEL_RADIUS, (front ? 1 : -1) * WHEELBASE_HALF)
      const spin = new Group()
      steer.add(spin)
      const tire = new Mesh(tireGeo, tireMat)
      const rim = new Mesh(rimGeo, rimMat)
      rim.position.x = side * 0.09
      const disc = new Mesh(discGeo, discMat)
      disc.position.x = side * 0.04
      spin.add(tire, rim, disc)
      const caliper = new Mesh(caliperGeo, caliperMat)
      caliper.position.set(side * 0.07, 0.12, front ? -0.1 : 0.1)
      steer.add(caliper)
      root.add(steer)
      wheels.push({ steer, spin, front, side })
    }
  }

  root.traverse((o) => {
    o.castShadow = false
    o.receiveShadow = false
  })

  return { root, body, wheels, flames, uniforms: { brake, nitro, reverse }, pointLights, headlightPositions }
}
