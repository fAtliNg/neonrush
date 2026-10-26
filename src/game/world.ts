import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Matrix4,
  Mesh,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Scene,
  SphereGeometry,
  SpotLight,
  Vector3,
  AdditiveBlending,
  BackSide,
  CatmullRomCurve3,
  ExtrudeGeometry,
  Path,
  Shape,
  TubeGeometry,
} from 'three/webgpu'
import {
  abs,
  attribute,
  clamp,
  color,
  exp,
  float,
  floor,
  fract,
  hash,
  lights,
  max,
  min,
  mix,
  mod,
  mx_fractal_noise_float,
  mx_noise_float,
  normalWorld,
  positionWorld,
  reflector,
  select,
  sin,
  smoothstep,
  step,
  texture,
  time,
  uv,
  vec2,
  vec3,
  cameraPosition,
  normalize,
  dot,
  pow,
  screenUV,
} from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { HALF_WIDTH, Track } from './track'
import { SIGNS, TUNNEL_SIGN, createLampColors, createSignAtlas, signUV } from './textures'
import { DIVIDERS, DIVIDER_HALF, GANTRIES, RIVER, TUNNEL, bridgeCrossings, inTunnel, riverDistance } from './features'
import type { Quality } from './quality'

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any

const LAMP_OFFSET = HALF_WIDTH + 1.6
const LAMP_HEIGHT = 9
const SIDEWALK = 6

/** Детерминированный генератор, чтобы город при каждом запуске был одинаковым */
export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Общие uniforms, которые мир читает в шейдерах и которыми управляет игра */
export interface WorldUniforms {
  carPos: N
  carDir: N
  brake: N
  underglow: N
}

/**
 * Протягивает профиль (lateral, y) вдоль трассы. UV: x — длина по профилю (м), y — путь вдоль трассы (м).
 */
function sweep(track: Track, profile: Array<[number, number]>, uOffset = 0, stride = 2, from = 0, to = track.count) {
  const n = track.count
  const rows = Math.ceil((to - from) / stride) + 1
  const cols = profile.length
  const pos = new Float32Array(rows * cols * 3)
  const uvs = new Float32Array(rows * cols * 2)
  const across: number[] = [0]
  for (let j = 1; j < cols; j++) {
    const [a, b] = [profile[j - 1], profile[j]]
    across.push(across[j - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]))
  }
  for (let r = 0; r < rows; r++) {
    const i = Math.min(from + r * stride, to)
    const p = track.at(i)
    for (let j = 0; j < cols; j++) {
      const [lat, y] = profile[j]
      const k = r * cols + j
      pos[k * 3] = p.x + p.nx * lat
      pos[k * 3 + 1] = y
      pos[k * 3 + 2] = p.z + p.nz * lat
      uvs[k * 2] = across[j] + uOffset
      uvs[k * 2 + 1] = (i / n) * track.length
    }
  }
  const index: number[] = []
  for (let r = 0; r < rows - 1; r++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = r * cols + j
      const b = a + cols
      index.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('uv', new BufferAttribute(uvs, 2))
  g.setIndex(index)
  g.computeVertexNormals()
  return g
}

export async function buildWorld(scene: Scene, track: Track, quality: Quality, u: WorldUniforms) {
  const root = new Group()
  scene.add(root)
  const rand = rng(1337)

  /* ---------- Небо и туман ---------- */
  const skyGeo = new SphereGeometry(2400, 32, 16)
  const skyMat = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false })
  {
    const dir = normalize(positionWorld.sub(cameraPosition)) as N
    const h = clamp(dir.y, 0, 1)
    const glow = exp(h.mul(-9)) // засветка города у горизонта
    const base = mix(color('#0b0820'), color('#020108'), pow(h, 0.5))
    const haze = mix(color('#ff2bd6'), color('#ff8a3c'), smoothstep(-0.2, 0.6, sin(dir.x.mul(2.0)).mul(0.5).add(0.5)))
    skyMat.colorNode = base.add(haze.mul(glow).mul(0.22)).add(color('#3a1d7a').mul(exp(h.mul(-3))).mul(0.25))
  }
  const sky = new Mesh(skyGeo, skyMat)
  sky.renderOrder = -1
  root.add(sky)

  /* ---------- Фонари: данные нужны асфальту ---------- */
  const lampCount = Math.round(track.length / 60) * 2
  const lampSpacing = track.length / lampCount
  const palette = [new Color('#ffb36b'), new Color('#7fd8ff'), new Color('#ff7ad9'), new Color('#ffd9a0'), new Color('#9b8cff')]
  const lampData = createLampColors(lampCount, palette)
  const bridges = bridgeCrossings(track)
  const noLamp = (sAt: number) =>
    inTunnel(sAt, track.length, 14) || bridges.some((b) => Math.abs(((sAt - b + track.length * 1.5) % track.length) - track.length / 2) < 34)
  {
    const data = lampData.texture.image.data as Uint8Array
    for (let i = 0; i < lampCount; i++) {
      if (!noLamp(i * lampSpacing)) continue
      lampData.colors[i] = new Color(0, 0, 0)
      data.fill(0, i * 4, i * 4 + 3)
    }
    lampData.texture.needsUpdate = true
  }

  /* ---------- Отражение мокрого асфальта ---------- */
  const reflection = reflector({ resolutionScale: quality.reflection, generateMipmaps: true, bounces: false }) as N
  reflection.target.rotateX(-Math.PI / 2)
  root.add(reflection.target)

  // Подсветка от фонарей, днища и стоп-сигналов — считается прямо в шейдере, без настоящих источников
  const lampPools = (s: N, lat: N) => {
    const k0 = floor(s.div(lampSpacing))
    let sum: N = vec3(0)
    for (const dk of [0, 1]) {
      const k = k0.add(dk)
      const side = select(mod(k, 2).lessThan(0.5), float(1), float(-1))
      const ds = s.sub(k.mul(lampSpacing))
      const dl = lat.sub(side.mul(LAMP_OFFSET - 2.4))
      const d2 = ds.mul(ds).mul(0.8).add(dl.mul(dl))
      const col = texture(lampData.texture, vec2(mod(k, lampCount).add(0.5).div(lampCount), 0.5)).rgb
      const pool = exp(d2.mul(-1 / 40)).mul(0.55).add(exp(d2.mul(-1 / 6)).mul(0.35))
      sum = sum.add(col.mul(pool))
    }
    return sum
  }

  const carLight = () => {
    const rel = positionWorld.xz.sub(u.carPos)
    const fwd = u.carDir
    const along = dot(rel, fwd)
    const side = dot(rel, vec2(fwd.y.negate(), fwd.x))
    // Тень от машины: мягкий прямоугольник
    const shadow = smoothstep(1.6, 2.6, abs(along)).max(smoothstep(0.7, 1.4, abs(side)))
    // Неон под днищем
    const glow = exp(along.mul(along).mul(-0.18).add(side.mul(side).mul(-0.9))).mul(u.underglow)
    // Красный отсвет фонарей сзади
    const back = along.add(2.4)
    const tail = exp(back.mul(back).mul(-0.35).add(side.mul(side).mul(-0.5))).mul(step(back, 0.4)).mul(u.brake.mul(1.4).add(0.35))
    return { shadow: mix(0.25, 1, shadow), glow, tail }
  }

  /* ---------- Асфальт ---------- */
  const road = sweep(track, [
    [-HALF_WIDTH, 0],
    [0, 0],
    [HALF_WIDTH, 0],
  ], -HALF_WIDTH)
  const roadMat = new MeshStandardNodeMaterial({ side: DoubleSide })
  {
    const lat = uv().x as N
    const s = uv().y as N
    const grain = mx_noise_float(vec2(lat, s).mul(3.1)).mul(0.5).add(0.5)
    const patches = mx_fractal_noise_float(vec3(lat.mul(0.09), s.mul(0.05), 3.0), 3).mul(0.5).add(0.5)
    const sMod0 = mod(s, track.length)
    const tun = step(TUNNEL.from, sMod0).mul(step(sMod0, TUNNEL.to))
    const puddle = smoothstep(0.52, 0.62, mx_fractal_noise_float(vec3(lat.mul(0.13), s.mul(0.07), 7.0), 3).mul(0.5).add(0.5))

    // Разметка: сплошные по краям, прерывистые между полосами, старт-финиш шашками
    const edge = step(abs(abs(lat).sub(HALF_WIDTH - 0.6)), 0.12)
    const laneU = abs(abs(lat).sub(HALF_WIDTH / 3))
    const dash = step(laneU, 0.1).mul(step(fract(s.div(12)), 0.45))
    const center = step(abs(lat), 0.09).mul(step(fract(s.div(6)), 0.5)).mul(0)
    const sFin = mod(s, track.length)
    const finish = step(min(sFin, float(track.length).sub(sFin)), 3.2)
    const checker = mod(floor(lat.div(0.8)).add(floor(s.div(0.8))), 2)
    const paint = clamp(edge.add(dash).add(center), 0, 1).mul(mx_noise_float(vec2(lat, s).mul(1.7)).mul(0.25).add(0.75))
    const paintAll = max(paint, finish.mul(checker))

    const asphalt = mix(color('#0a0a0e'), color('#16151b'), grain.mul(0.6).add(patches.mul(0.4)))
    const base = mix(asphalt, color('#b9b9c2'), paintAll.mul(0.8))
    const cl = carLight() as N
    roadMat.colorNode = base.mul(mix(1, 0.5, puddle)).mul(cl.shadow)
    roadMat.roughnessNode = mix(mix(0.42, 0.62, grain), float(0.04), puddle)
    roadMat.metalnessNode = float(0)

    // Капли дождя рисуют рябь в лужах: смещаем выборку отражения
    const cellP = vec2(lat, s).mul(1.3)
    const cid = floor(cellP)
    const ph = fract(time.mul(0.9).add(hash(cid.x.add(cid.y.mul(57.0)))))
    const rd = fract(cellP).sub(0.5).length()
    // В тоннеле асфальт мокрый, но капли не падают — ряби нет
    const ripple = sin(rd.sub(ph.mul(0.5)).mul(40)).mul(exp(ph.mul(-3))).mul(smoothstep(0.5, 0.0, rd)).mul(puddle).mul(float(1).sub(tun))
    const wobble = vec2(mx_noise_float(vec2(lat.mul(1.5), s.mul(0.35))), mx_noise_float(vec2(lat.mul(1.5).add(9), s.mul(0.35))))
    reflection.uvNode = reflection.uvNode.add(wobble.mul(mix(0.012, 0.002, puddle)).add(vec2(ripple.mul(0.004))))

    // Свойство, а не .level(): клон узла отражения читал бы не ту текстуру
    reflection.levelNode = mix(3.5, 0.0, puddle)
    const blurred = reflection
    const viewDir = normalize(cameraPosition.sub(positionWorld))
    const fres = pow(float(1).sub(clamp(dot(viewDir, vec3(0, 1, 0)), 0, 1)), 3).mul(0.7).add(0.3)
    const reflStrength = mix(0.28, 0.95, puddle).mul(fres).mul(mix(1, 0.4, paintAll))
    const pools = lampPools(s, lat)
    // Натриевые лампы тоннеля: пятна каждые 10 м по двум рядам
    const ts = fract(s.div(10)).sub(0.5).mul(10)
    const tl = abs(lat).sub(4)
    const tunnelLight = color('#ffae5c').mul(exp(ts.mul(ts).mul(-0.05).add(tl.mul(tl).mul(-0.04))).mul(0.7).add(0.22)).mul(tun)
    roadMat.emissiveNode = blurred.rgb
      .add(tunnelLight.mul(base.mul(5).add(0.06)))
      .mul(reflStrength)
      .add(pools.mul(base.mul(4).add(0.05)).mul(cl.shadow))
      .add(color('#2bf0ff').mul(cl.glow).mul(0.5))
      .add(color('#ff1030').mul(cl.tail).mul(0.35))
  }
  const roadMesh = new Mesh(road, roadMat)
  roadMesh.layers.set(1)
  root.add(roadMesh)

  // Тротуары и земля читают ту же текстуру отражения через обычный texture(): значение обновляется каждый кадр
  const reflTex = texture(reflection.value) as N
  const reflUV = screenUV.flipX()
  const syncReflection = () => {
    reflTex.value = reflection.value
  }

  /* ---------- Тротуары и бордюры ---------- */
  const walkMat = new MeshStandardNodeMaterial({ side: DoubleSide })
  {
    const a = uv().x as N
    const s = uv().y as N
    const tile = vec2(a, s).div(1.5)
    const grout = step(0.06, fract(tile.x)).mul(step(0.06, fract(tile.y)))
    const curb = smoothstep(0.3, 0.1, abs(a))
    const tint = hash(floor(tile.x).add(floor(tile.y).mul(31.7))).mul(0.04)
    walkMat.colorNode = mix(color('#1a1a20').add(tint), color('#3a3a44'), curb).mul(grout.mul(0.5).add(0.5))
    walkMat.roughnessNode = mix(float(0.5), float(0.3), grout)
    walkMat.emissiveNode = reflTex.sample(reflUV).level(4.0).rgb.mul(0.07)
  }
  const walkProfile: Array<[number, number]> = [
    [HALF_WIDTH, 0],
    [HALF_WIDTH, 0.16],
    [HALF_WIDTH + 0.4, 0.16],
    [HALF_WIDTH + SIDEWALK, 0.16],
  ]
  const walks = mergeGeometries([
    sweep(track, walkProfile),
    sweep(
      track,
      walkProfile.map(([l, y]) => [-l, y] as [number, number]),
    ),
  ])
  const walkMesh = new Mesh(walks, walkMat)
  // Слой 1 не попадает в камеру отражения: эти материалы сами читают текстуру отражения
  walkMesh.layers.set(1)
  root.add(walkMesh)

  /* ---------- Отбойники с неоновой полосой ---------- */
  const barrierMat = new MeshStandardNodeMaterial({ side: DoubleSide })
  {
    const a = uv().x as N
    const s = uv().y as N
    const stripe = smoothstep(0.04, 0.0, abs(a.sub(0.78)))
    const chevron = step(0.5, fract(s.div(4).add(a.mul(0.3))))
    const sector = fract(s.div(track.length).mul(6))
    const neon = mix(color('#ff2bd6'), color('#2bf0ff'), step(0.5, sector))
    barrierMat.colorNode = mix(color('#26262e'), color('#3a3a44'), chevron.mul(0.4))
    barrierMat.roughnessNode = float(0.55)
    barrierMat.emissiveNode = neon.mul(stripe).mul(3.5)
  }
  const barrierProfile: Array<[number, number]> = [
    [HALF_WIDTH + 0.5, 0.16],
    [HALF_WIDTH + 0.5, 0.75],
    [HALF_WIDTH + 0.62, 1.0],
    [HALF_WIDTH + 0.88, 1.0],
    [HALF_WIDTH + 1.0, 0.75],
    [HALF_WIDTH + 1.0, 0.16],
  ]
  const barriers = mergeGeometries([
    sweep(track, barrierProfile),
    sweep(
      track,
      barrierProfile.map(([l, y]) => [-l, y] as [number, number]),
    ),
  ])
  root.add(new Mesh(barriers, barrierMat))

  /* ---------- Разделители по оси дороги ---------- */
  {
    const divMat = new MeshStandardNodeMaterial({ side: DoubleSide })
    const a = uv().x as N
    const sAlong = uv().y as N
    const chevron = step(0.5, fract(sAlong.div(1.2)))
    divMat.colorNode = mix(color('#2a2a33'), color('#3a3944'), chevron.mul(0.3))
    divMat.roughnessNode = float(0.6)
    // Светящаяся полоса по гребню и световозвращатели
    const crest = exp(a.sub(1.03).pow(2).mul(-200))
    const reflectors = step(0.85, fract(sAlong.div(4))).mul(exp(a.sub(0.45).pow(2).mul(-150)))
    divMat.emissiveNode = color('#ffd23c').mul(crest.mul(3)).add(color('#ffffff').mul(reflectors).mul(1.2))
    divMat.lightsNode = lights([])
    const prof: Array<[number, number]> = [
      [DIVIDER_HALF, 0],
      [DIVIDER_HALF - 0.05, 0.25],
      [0.14, 0.8],
      [-0.14, 0.8],
      [-(DIVIDER_HALF - 0.05), 0.25],
      [-DIVIDER_HALF, 0],
    ]
    for (const d of DIVIDERS) root.add(new Mesh(sweep(track, prof, 0, 1, Math.round(d.from), Math.round(d.to)), divMat))
  }

  /* ---------- Земля вокруг ---------- */
  const groundMat = new MeshStandardNodeMaterial()
  {
    const p = positionWorld.xz as N
    const n = mx_fractal_noise_float(vec3(p.mul(0.05), 1.0), 3).mul(0.5).add(0.5)
    groundMat.colorNode = mix(color('#060609'), color('#0e0e13'), n)
    groundMat.roughnessNode = float(0.3)
    groundMat.emissiveNode = reflTex.sample(reflUV).level(3.5).rgb.mul(smoothstep(0.45, 0.7, n).mul(0.3).add(0.06))
  }
  // Земля — две полуплоскости по берегам реки
  const riverYaw = Math.atan2(-RIVER.nz, RIVER.nx)
  const halves: BufferGeometry[] = []
  for (const sgn of [-1, 1]) {
    const g = new PlaneGeometry(3000, 6000).rotateX(-Math.PI / 2).rotateY(riverYaw)
    const off = RIVER.c + sgn * (RIVER.halfWidth + 1500)
    g.translate(RIVER.nx * off, -0.05, RIVER.nz * off)
    halves.push(g)
  }
  const ground = new Mesh(mergeGeometries(halves), groundMat)
  ground.layers.set(1)
  root.add(ground)

  /* ---------- Река ---------- */
  const quayMat = new MeshStandardNodeMaterial({ side: DoubleSide })
  {
    const p = positionWorld as N
    const along = p.x.mul(-RIVER.nz).add(p.z.mul(RIVER.nx))
    const block = step(0.04, fract(along.div(2.4))).mul(step(0.05, fract(p.y.div(0.8))))
    quayMat.colorNode = mix(color('#0c0c12'), color('#191820'), block)
    quayMat.roughnessNode = float(0.6)
    // Подсветка набережной: тёплая полоса у воды и холодная под парапетом
    const warmLine = exp(p.y.sub(RIVER.water + 0.9).pow(2).mul(-30)).mul(2.2)
    const coolLine = exp(p.y.add(0.5).pow(2).mul(-80)).mul(3)
    quayMat.emissiveNode = color('#ffb46a').mul(warmLine).add(color('#2bf0ff').mul(coolLine)).add(color('#0a0812'))
  }
  quayMat.lightsNode = lights([])
  const quays: BufferGeometry[] = []
  for (const sgn of [-1, 1]) {
    const g = new PlaneGeometry(6000, -RIVER.water + 0.6).rotateY(riverYaw + Math.PI / 2)
    const off = RIVER.c + sgn * RIVER.halfWidth
    g.translate(RIVER.nx * off, (RIVER.water - 0.6) / 2 - 0.05, RIVER.nz * off)
    quays.push(g)
  }
  root.add(new Mesh(mergeGeometries(quays), quayMat))

  const waterMat = new MeshStandardNodeMaterial()
  {
    const p = positionWorld.xz as N
    const wave = vec2(
      mx_noise_float(vec3(p.mul(0.12), time.mul(0.35))),
      mx_noise_float(vec3(p.mul(0.12).add(31.0), time.mul(0.35))),
    )
    const fine = mx_noise_float(vec3(p.mul(0.9), time.mul(1.2))).mul(0.5).add(0.5)
    const refl = reflTex.sample(reflUV.add(wave.mul(0.025))).level(1.5).rgb
    waterMat.colorNode = color('#02040a')
    waterMat.roughnessNode = float(0.08)
    waterMat.emissiveNode = refl.mul(0.75).mul(fine.mul(0.5).add(0.6)).add(color('#04101c').mul(0.4))
  }
  waterMat.lightsNode = lights([])
  const water = new Mesh(new PlaneGeometry(RIVER.halfWidth * 2 + 2, 6000).rotateX(-Math.PI / 2).rotateY(riverYaw), waterMat)
  water.position.set(RIVER.nx * RIVER.c, RIVER.water, RIVER.nz * RIVER.c)
  water.layers.set(1)
  root.add(water)

  // Пролёт моста: плита под дорогой и тротуарами. Тянется по всей трассе, но видна только над рекой — дальше её закрывает земля
  const deckMat = new MeshStandardNodeMaterial({ color: '#121218', roughness: 0.7, metalness: 0.2 })
  deckMat.lightsNode = lights([])
  {
    const a = uv().x as N
    deckMat.emissiveNode = color('#ff2bd6').mul(exp(a.sub(0.35).pow(2).mul(-200)).mul(2.5))
  }
  const deckProfile: Array<[number, number]> = [
    [HALF_WIDTH + SIDEWALK, 0.1],
    [HALF_WIDTH + SIDEWALK, -0.9],
    [HALF_WIDTH + SIDEWALK - 1.5, -1.8],
    [-(HALF_WIDTH + SIDEWALK - 1.5), -1.8],
    [-(HALF_WIDTH + SIDEWALK), -0.9],
    [-(HALF_WIDTH + SIDEWALK), 0.1],
  ]
  root.add(new Mesh(sweep(track, deckProfile), deckMat))

  /* ---------- Здания ---------- */
  type B = { x: number; z: number; w: number; d: number; h: number; rot: number; front?: boolean; y?: number; top?: boolean }
  const buildings: B[] = []
  const clearance = HALF_WIDTH + SIDEWALK + 1.5

  const fits = (b: B) => {
    const c = Math.cos(b.rot)
    const s = Math.sin(b.rot)
    for (const [ox, oz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
      [0, 0],
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ]) {
      const lx = (ox * b.w) / 2
      const lz = (oz * b.d) / 2
      const x = b.x + lx * c + lz * s
      const z = b.z - lx * s + lz * c
      if (track.distanceTo(x, z) < clearance) return false
    }
    return true
  }

  const clearOfRiver = (b: B) => Math.abs(riverDistance(b.x, b.z)) > RIVER.halfWidth + Math.hypot(b.w, b.d) / 2 + 5

  // Первая линия: фасадами к трассе
  for (const side of [1, -1]) {
    let s = 0
    while (s < track.length) {
      const w = 10 + rand() * 16
      const d = 14 + rand() * 18
      const tall = rand()
      const h = tall > 0.9 ? 60 + rand() * 70 : tall > 0.55 ? 24 + rand() * 30 : 9 + rand() * 16
      const p = track.sample(s + w / 2, side * (clearance + 0.8 + d / 2 + rand() * 2))
      const b: B = { x: p.x, z: p.z, w, d, h, rot: Math.atan2(p.tx, p.tz) + Math.PI / 2, front: true }
      if (fits(b) && clearOfRiver(b)) buildings.push(b)
      s += w + 0.5 + rand() * 3
    }
  }

  // Остальной город: сетка кварталов внутри и вокруг кольца
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of track.points) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z)
    maxZ = Math.max(maxZ, p.z)
  }
  const pad = 380
  const cell = 34
  for (let x = minX - pad; x < maxX + pad; x += cell) {
    for (let z = minZ - pad; z < maxZ + pad; z += cell) {
      const w = 14 + rand() * 16
      const d = 14 + rand() * 16
      const far = Math.min(1, Math.max(0, (track.distanceTo(x, z) - 40) / 260))
      const h = 12 + rand() * 40 + far * far * (60 + rand() * 120) + (rand() > 0.94 ? 80 : 0)
      const b: B = { x: x + (rand() - 0.5) * 8, z: z + (rand() - 0.5) * 8, w, d, h, rot: 0 }
      if (track.distanceTo(b.x, b.z) > clearance + Math.max(w, d) * 0.75 + 2 && clearOfRiver(b) && fits(b)) buildings.push(b)
    }
  }

  // Ярусы высоток: на крышу ставим уменьшенные корпуса
  const tiers: B[] = []
  for (const b of buildings) {
    b.top = true
    if (b.h > 38 && rand() < 0.6) {
      b.top = false
      const t1: B = { ...b, w: b.w * 0.74, d: b.d * 0.74, h: 6 + b.h * 0.22, y: b.h, front: false, top: true }
      tiers.push(t1)
      if (b.h > 80 && rand() < 0.6) {
        t1.top = false
        tiers.push({ ...t1, w: t1.w * 0.6, d: t1.d * 0.6, h: 5 + b.h * 0.12, y: t1.y! + t1.h, top: true })
      }
    }
  }
  const blocks = [...buildings, ...tiers]

  const boxGeo = new BoxGeometry(1, 1, 1)
  boxGeo.translate(0, 0.5, 0)
  const buildingMat = new MeshStandardNodeMaterial()
  {
    const wp = positionWorld as N
    const nw = normalWorld as N
    const isX = abs(nw.x).greaterThan(abs(nw.z))
    const across = select(isX, wp.z, wp.x)
    const seed = attribute('aSeed', 'float') as N
    const kind = fract(seed.mul(4.31)) // 0..0.25 стекло, 0.25..0.6 бетон, остальное кирпич
    const glassy = step(kind, 0.25)
    const winW = mix(1.5, 2.3, fract(seed.mul(7.13)))
    const winH = mix(3.1, 3.6, fract(seed.mul(3.71)))
    const cellUV = vec2(across.div(winW), wp.y.div(winH))
    const id = floor(cellUV)
    const f = fract(cellUV)
    // У стеклянных башен окна почти во всю ячейку, у остальных — проёмы в стене
    const fx0 = mix(0.2, 0.06, glassy)
    const fy0 = mix(0.3, 0.1, glassy)
    const frame = step(fx0, f.x).mul(step(f.x, float(1).sub(fx0))).mul(step(fy0, f.y)).mul(step(f.y, 0.82))
    // Откос: тёмная рамка внутри проёма даёт ощущение глубины
    const inset = smoothstep(fx0, fx0.add(0.06), f.x).mul(smoothstep(float(1).sub(fx0), float(1).sub(fx0).sub(0.06), f.x)).mul(smoothstep(fy0, fy0.add(0.08), f.y))
    const h1 = hash(id.x.mul(12.9898).add(id.y.mul(78.233)).add(seed.mul(437.0)))
    const h2 = hash(id.x.mul(3.17).add(id.y.mul(91.7)).add(seed.mul(17.0)))
    const h3 = hash(id.x.mul(7.7).add(id.y.mul(3.3)).add(seed.mul(71.0)))
    const density = mix(0.12, 0.45, fract(seed.mul(1.37))).add(glassy.mul(0.12))
    const lit = step(float(1).sub(density), h1)
    const warm = mix(color('#ffb46a'), color('#ffe0b0'), h2)
    const cool = mix(color('#7fc8ff'), color('#c9e6ff'), h2)
    const neonish = mix(color('#ff4fd8'), color('#4ff0ff'), h2)
    const tint = select(h2.greaterThan(0.93), neonish, select(h2.greaterThan(0.55), cool, warm))
    // Жалюзи в части окон и мерцающий синий телевизор в редких
    const blinds = select(h3.greaterThan(0.7), step(0.45, fract(f.y.mul(9))).mul(0.6).add(0.25), float(1))
    const tv = step(0.985, h3).mul(mx_noise_float(vec2(time.mul(6), h3.mul(50))).mul(0.5).add(0.6))
    const interior = mix(float(0.55), float(1), f.y) // к потолку светлее
    const wall = step(abs(nw.y), 0.5)
    const baseY = attribute('aBase', 'float') as N
    const above = step(baseY.add(4.5), wp.y).max(step(0.5, baseY))
    const glow = lit
      .mul(frame)
      .mul(wall)
      .mul(above)
      .mul(pow(fract(h1.mul(13.7)), 2).mul(0.8).add(0.2))
      .mul(blinds)
      .mul(interior)

    // Межэтажные пояса и пилястры
    const slab = step(fract(wp.y.div(winH)), 0.07).mul(float(1).sub(glassy))
    const pilaster = step(fract(across.div(winW.mul(4))), 0.05).mul(float(1).sub(glassy))

    // Первый этаж — витрины
    const shop = step(wp.y, 3.6).mul(step(0.4, wp.y)).mul(wall).mul(step(0.12, fract(across.div(5.0)))).mul(step(baseY, 0.5))
    const shopTint = mix(color('#ff8a3c'), color('#3cd8ff'), step(0.5, fract(seed.mul(5.3))))

    const concrete = mix(color('#121219'), color('#1d1b25'), hash(seed.mul(9.1)))
    const brick = mix(color('#1a0f12'), color('#26161a'), hash(seed.mul(5.7)))
    const glass = mix(color('#06080f'), color('#0b0e18'), hash(seed.mul(2.3)))
    const facade = select(glassy.greaterThan(0.5), glass, select(kind.lessThan(0.6), concrete, brick))
      .mul(float(1).add(slab.mul(0.6)).add(pilaster.mul(0.4)))
    const windowDark = mix(color('#05050a'), color('#0a0d18'), glassy)
    buildingMat.colorNode = mix(facade, windowDark, frame.mul(wall).mul(above))
    buildingMat.roughnessNode = mix(float(0.85), float(0.12), frame.mul(wall).max(glassy.mul(0.6)))
    buildingMat.metalnessNode = glassy.mul(0.5).add(0.05)
    buildingMat.emissiveNode = tint
      .mul(glow)
      .mul(inset.mul(0.6).add(0.4))
      .mul(0.75)
      .add(color('#5a8cff').mul(tv).mul(frame).mul(wall).mul(0.9))
      .add(shopTint.mul(shop).mul(0.6).mul(step(0.35, fract(seed.mul(2.9)))))
      .add(facade.mul(0.2))
  }
  buildingMat.lightsNode = lights([])

  const bMesh = new InstancedMesh(boxGeo, buildingMat, blocks.length)
  const seeds = new Float32Array(blocks.length)
  const bases = new Float32Array(blocks.length)
  const m = new Matrix4()
  const q = new Quaternion()
  const up = new Vector3(0, 1, 0)
  const seedOf = new Map<B, number>()
  buildings.forEach((b) => seedOf.set(b, rand()))
  blocks.forEach((b, i) => {
    q.setFromAxisAngle(up, b.rot)
    m.compose(new Vector3(b.x, b.y ?? 0, b.z), q, new Vector3(b.w, b.h, b.d))
    bMesh.setMatrixAt(i, m)
    // Ярус наследует материал основного корпуса
    const parent = buildings.find((p) => p.x === b.x && p.z === b.z)
    seeds[i] = parent ? (seedOf.get(parent) ?? rand()) : rand()
    bases[i] = b.y ?? 0
  })
  boxGeo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1))
  boxGeo.setAttribute('aBase', new InstancedBufferAttribute(bases, 1))
  root.add(bMesh)

  /* ---------- Крыши: парапеты, техника, баки, антенны, огни ---------- */
  const tops = blocks.filter((b) => b.top)
  const roofMat = new MeshStandardNodeMaterial({ color: '#16151d', roughness: 0.75, metalness: 0.3 })
  roofMat.lightsNode = lights([])
  {
    const p = positionWorld as N
    // Редкие светящиеся решётки вентиляции
    const vent: N = step(0.92, hash(floor(p.x.div(3)).add(floor(p.z.div(3)).mul(17.0)))).mul(step(0.6, fract(p.y.mul(3))))
    roofMat.emissiveNode = (color('#0b0a12') as N).add(color('#ff6a3c').mul(vent as N).mul(0.5))
  }
  const parapetM: Matrix4[] = []
  const boxM: Matrix4[] = []
  const tankM: Matrix4[] = []
  const antennaM: Matrix4[] = []
  const blinkPos: Vector3[] = []
  const local = (b: B, lx: number, ly: number, lz: number) => {
    const c = Math.cos(b.rot)
    const sn = Math.sin(b.rot)
    return new Vector3(b.x + lx * c + lz * sn, (b.y ?? 0) + b.h + ly, b.z - lx * sn + lz * c)
  }
  for (const b of tops) {
    q.setFromAxisAngle(up, b.rot)
    // Парапет — чуть шире крыши
    parapetM.push(new Matrix4().compose(local(b, 0, -0.4, 0), q, new Vector3(b.w + 0.5, 1.2, b.d + 0.5)))
    const n = 1 + Math.floor(rand() * 3)
    for (let k = 0; k < n; k++) {
      const sw = 1.5 + rand() * 3
      const sh = 1 + rand() * 2.2
      const sd = 1.5 + rand() * 3
      const pos = local(b, (rand() - 0.5) * (b.w - sw - 1), 0, (rand() - 0.5) * (b.d - sd - 1))
      boxM.push(new Matrix4().compose(pos, q, new Vector3(sw, sh, sd)))
    }
    if (b.h + (b.y ?? 0) < 40 && rand() < 0.35) {
      tankM.push(new Matrix4().compose(local(b, (rand() - 0.5) * (b.w - 4), 0.6, (rand() - 0.5) * (b.d - 4)), q, new Vector3(1, 1, 1)))
    }
    const topY = (b.y ?? 0) + b.h
    if (topY > 45) {
      const ah = 6 + rand() * 12
      const pos = local(b, 0, 0, 0)
      antennaM.push(new Matrix4().compose(pos, q, new Vector3(1, ah, 1)))
      blinkPos.push(pos.clone().setY(pos.y + ah + 0.3))
    }
  }
  const unitBox = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
  const addInstanced = (geo: BufferGeometry, mat: MeshStandardNodeMaterial | MeshBasicNodeMaterial, list: Matrix4[]) => {
    if (!list.length) return
    const mesh = new InstancedMesh(geo, mat, list.length)
    list.forEach((mm, i) => mesh.setMatrixAt(i, mm))
    root.add(mesh)
  }
  addInstanced(unitBox, roofMat, parapetM)
  addInstanced(unitBox, roofMat, boxM)
  addInstanced(
    mergeGeometries([
      new CylinderGeometry(1.3, 1.3, 2.6, 14).translate(0, 2.2, 0),
      new ConeGeometry(1.4, 0.8, 14).translate(0, 3.9, 0),
      new CylinderGeometry(0.08, 0.08, 1, 4).translate(-0.8, 0.5, -0.8),
      new CylinderGeometry(0.08, 0.08, 1, 4).translate(0.8, 0.5, 0.8),
    ]),
    roofMat,
    tankM,
  )
  addInstanced(new CylinderGeometry(0.08, 0.16, 1, 5).translate(0, 0.5, 0), roofMat, antennaM)

  const blinkGeo = new SphereGeometry(0.5, 8, 6)
  const blinkMat = new MeshBasicNodeMaterial()
  {
    const ph = attribute('aPhase', 'float') as N
    blinkMat.colorNode = color('#ff1a2a').mul(step(0.55, fract(time.mul(0.7).add(ph))).mul(14).add(0.6))
  }
  const blinks = new InstancedMesh(blinkGeo, blinkMat, Math.max(1, blinkPos.length))
  const phases = new Float32Array(Math.max(1, blinkPos.length))
  blinkPos.forEach((pos, i) => {
    m.makeTranslation(pos.x, pos.y, pos.z)
    blinks.setMatrixAt(i, m)
    phases[i] = rand()
  })
  blinkGeo.setAttribute('aPhase', new InstancedBufferAttribute(phases, 1))
  if (blinkPos.length) root.add(blinks)

  /* ---------- Неоновые вывески и трубки на фасадах первой линии ---------- */
  const atlas = await createSignAtlas()
  const signMat = new MeshBasicNodeMaterial({ side: DoubleSide })
  {
    const fl = attribute('aFlick', 'float') as N
    const flicker = select(
      fl.greaterThan(0.5),
      step(0.25, mx_noise_float(vec2((time as N).mul(fl), fl.mul(3.0)))).mul(0.85).add(0.15),
      float(1),
    )
    signMat.colorNode = texture(atlas, uv()).rgb.mul(4.2).mul(flicker)
  }
  const signGeos: BufferGeometry[] = []
  const tubeGeos: BufferGeometry[] = []
  const tmp = new Object3D()
  const legGeos: BufferGeometry[] = []
  const pickSign = () => {
    const i = Math.floor(rand() * (SIGNS.length - 1))
    return i >= TUNNEL_SIGN ? i + 1 : i
  }
  const front = buildings.filter((b) => b.front)
  front.forEach((b, i) => {
    // Фасад — грань, обращённая к трассе
    const cx = Math.cos(b.rot)
    const sx = Math.sin(b.rot)
    // Локальная ось z здания смотрит перпендикулярно трассе; выбираем сторону ближе к дороге
    const near = track.nearest(b.x, b.z)
    const toRoadX = near.point.x - b.x
    const toRoadZ = near.point.z - b.z
    const dirSign = toRoadX * sx + toRoadZ * cx > 0 ? 1 : -1
    const fx = sx * dirSign
    const fz = cx * dirSign
    const faceX = b.x + fx * (b.d / 2 + 0.08)
    const faceZ = b.z + fz * (b.d / 2 + 0.08)
    const yaw = Math.atan2(fx, fz)

    if (b.top && b.h < 30 && rand() < 0.35) {
      // Щит на крыше на двух опорах
      const sw = Math.min(14, b.w * 0.9)
      const sh = sw / 2
      const g = signPlane(pickSign(), sw, sh, rand() < 0.1 ? 3 + rand() * 6 : 0)
      tmp.position.set(faceX - fx * 2, b.h + 2 + sh / 2, faceZ - fz * 2)
      tmp.rotation.set(0, yaw, 0)
      tmp.updateMatrix()
      g.applyMatrix4(tmp.matrix)
      signGeos.push(g)
      for (const e of [-1, 1]) {
        legGeos.push(
          new BoxGeometry(0.25, 2 + sh, 0.25).translate(faceX - fx * 2.2 + e * sw * 0.35 * cx, b.h + (2 + sh) / 2, faceZ - fz * 2.2 - e * sw * 0.35 * sx),
        )
      }
    }

    if (rand() < 0.7) {
      const idx = pickSign()
      const sw = Math.min(b.w * 0.8, 5 + rand() * 6)
      const sh = sw / 2
      const y = Math.min(b.h - sh / 2 - 1, 5 + rand() * Math.max(1, b.h * 0.4))
      const g = new PlaneGeometry(sw, sh)
      const { u0, u1, v0, v1 } = signUV(idx)
      const uvA = g.getAttribute('uv') as BufferAttribute
      for (let k = 0; k < uvA.count; k++) {
        uvA.setXY(k, uvA.getX(k) ? u1 : u0, uvA.getY(k) ? v1 : v0)
      }
      tmp.position.set(faceX + (rand() - 0.5) * (b.w - sw) * cx * 0.6, y, faceZ - (rand() - 0.5) * (b.w - sw) * sx * 0.6)
      tmp.rotation.set(0, yaw, 0)
      tmp.updateMatrix()
      g.applyMatrix4(tmp.matrix)
      const flick = new Float32Array(uvA.count).fill(rand() < 0.15 ? rand() * 10 + 1 : 0)
      g.setAttribute('aFlick', new BufferAttribute(flick, 1))
      signGeos.push(g)
    }

    // Вертикальные неоновые трубки по углам фасада
    if (rand() < 0.55) {
      const hue = new Color().setHSL(rand() < 0.5 ? 0.86 + rand() * 0.08 : 0.5 + rand() * 0.08, 1, 0.55)
      for (const edge of [-1, 1]) {
        const g = new BoxGeometry(0.18, b.h * 0.85, 0.18)
        g.translate(0, b.h * 0.85 * 0.5 + b.h * 0.08, 0)
        tmp.position.set(faceX + edge * (b.w / 2 - 0.2) * cx, 0, faceZ - edge * (b.w / 2 - 0.2) * sx)
        tmp.rotation.set(0, yaw, 0)
        tmp.updateMatrix()
        g.applyMatrix4(tmp.matrix)
        const cols = new Float32Array(g.getAttribute('position').count * 3)
        for (let k = 0; k < cols.length; k += 3) {
          cols[k] = hue.r
          cols[k + 1] = hue.g
          cols[k + 2] = hue.b
        }
        g.setAttribute('color', new BufferAttribute(cols, 3))
        g.deleteAttribute('uv')
        g.deleteAttribute('normal')
        tubeGeos.push(g)
      }
    }
    if (i % 3 === 0 && rand() < 0.6) {
      // Горизонтальная полоса под карнизом
      const hue = new Color().setHSL(rand(), 1, 0.6)
      const g = new BoxGeometry(b.w * 0.96, 0.16, 0.16)
      tmp.position.set(faceX, b.h - 0.6, faceZ)
      tmp.rotation.set(0, yaw, 0)
      tmp.updateMatrix()
      g.applyMatrix4(tmp.matrix)
      const cols = new Float32Array(g.getAttribute('position').count * 3)
      for (let k = 0; k < cols.length; k += 3) {
        cols[k] = hue.r
        cols[k + 1] = hue.g
        cols[k + 2] = hue.b
      }
      g.setAttribute('color', new BufferAttribute(cols, 3))
      g.deleteAttribute('uv')
      g.deleteAttribute('normal')
      tubeGeos.push(g)
    }
  })

  if (signGeos.length) root.add(new Mesh(mergeGeometries(signGeos), signMat))
  if (legGeos.length) root.add(new Mesh(mergeGeometries(legGeos), roofMat))
  if (tubeGeos.length) {
    const tubeMat = new MeshBasicNodeMaterial({ vertexColors: true })
    tubeMat.colorNode = attribute('color', 'vec3').mul(5.0)
    root.add(new Mesh(mergeGeometries(tubeGeos), tubeMat))
  }

  /* ---------- Табло на порталах над дорогой (опоры — в obstacles.ts) ---------- */
  GANTRIES.forEach((sAt, i) => {
    const p = track.sample(sAt)
    const sign = new Mesh(signPlane([3, 4, 8][i % 3], 7, 1.75), signMat)
    sign.position.set(p.x, 7.4, p.z)
    // Лицом к тем, кто едет навстречу табло
    sign.rotation.y = Math.atan2(-p.tx, -p.tz)
    sign.translateZ(0.5)
    root.add(sign)
  })

  /* ---------- Фонари ---------- */
  const poleGeo = mergeGeometries([
    new CylinderGeometry(0.09, 0.14, LAMP_HEIGHT, 8).translate(0, LAMP_HEIGHT / 2, 0),
    new BoxGeometry(0.1, 0.1, 2.6).translate(0, LAMP_HEIGHT - 0.05, 1.25),
  ])
  const poleMat = new MeshStandardNodeMaterial({ color: '#202028', roughness: 0.4, metalness: 0.8 })
  const headGeo = new BoxGeometry(0.42, 0.12, 1.0)
  const headMat = new MeshBasicNodeMaterial()
  headMat.colorNode = color('#ffffff').mul(9)
  const coneGeo = new ConeGeometry(3.4, LAMP_HEIGHT - 0.2, 32, 1, true)
  coneGeo.translate(0, -(LAMP_HEIGHT - 0.2) / 2, 0)
  const coneMat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  })
  {
    // Объёмный конус света в дожде: ярче у лампы, мягкие края
    const v = uv().y as N
    const viewDir = normalize(cameraPosition.sub(positionWorld))
    const edge = abs(dot(normalWorld, viewDir))
    const dust = mx_noise_float(positionWorld.mul(vec3(0.6, 0.25, 0.6)).add(vec3(0, time.mul(-1.6), 0))).mul(0.35).add(0.75)
    coneMat.colorNode = vec3(1).mul(pow(v, 2.2)).mul(pow(edge, 1.6)).mul(dust).mul(quality.volumetric ? 0.07 : 0)
  }
  const poles = new InstancedMesh(poleGeo, poleMat, lampCount)
  const heads = new InstancedMesh(headGeo, headMat, lampCount)
  const cones = new InstancedMesh(coneGeo, coneMat, lampCount)
  for (let i = 0; i < lampCount; i++) {
    if (noLamp(i * lampSpacing)) {
      m.makeScale(0, 0, 0)
      poles.setMatrixAt(i, m)
      heads.setMatrixAt(i, m)
      cones.setMatrixAt(i, m)
      continue
    }
    const side = i % 2 === 0 ? 1 : -1
    const p = track.sample(i * lampSpacing, side * LAMP_OFFSET)
    // Рука фонаря смотрит на дорогу
    const yaw = Math.atan2(p.tx, p.tz) + (side > 0 ? -Math.PI / 2 : Math.PI / 2)
    q.setFromAxisAngle(up, yaw)
    m.compose(new Vector3(p.x, 0.16, p.z), q, new Vector3(1, 1, 1))
    poles.setMatrixAt(i, m)
    const hx = p.x + Math.sin(yaw) * 2.4
    const hz = p.z + Math.cos(yaw) * 2.4
    m.compose(new Vector3(hx, LAMP_HEIGHT - 0.12, hz), q, new Vector3(1, 1, 1))
    heads.setMatrixAt(i, m)
    heads.setColorAt(i, lampData.colors[i])
    m.compose(new Vector3(hx, LAMP_HEIGHT - 0.2, hz), q, new Vector3(1, 1, 1))
    cones.setMatrixAt(i, m)
    cones.setColorAt(i, lampData.colors[i])
  }
  root.add(poles, heads)
  if (quality.volumetric) root.add(cones)

  const lampPositions: Vector3[] = []
  for (let i = 0; i < lampCount; i++) {
    const side = i % 2 === 0 ? 1 : -1
    const p = track.sample(i * lampSpacing, side * (LAMP_OFFSET - 2.4))
    lampPositions.push(new Vector3(p.x, LAMP_HEIGHT - 0.4, p.z))
  }
  const lampColors = [...lampData.colors]

  /* ---------- Мосты: неоновые арки над рекой ---------- */
  const steelMat = new MeshStandardNodeMaterial({ color: '#1c1c24', roughness: 0.35, metalness: 0.85 })
  steelMat.lightsNode = lights([])
  steelMat.emissiveNode = color('#0d0a18')
  const bridgeGeos: BufferGeometry[] = []
  const neonArch: Array<{ g: BufferGeometry; c: Color }> = []
  const pierGeos: BufferGeometry[] = []
  bridges.forEach((idx, bi) => {
    const span = RIVER.halfWidth * 1.35
    const s0 = idx - span
    const s1 = idx + span
    const hue = new Color(bi % 2 ? '#ff2bd6' : '#2bf0ff')
    const archY = (t: number) => 2.2 + 15 * Math.sin(Math.PI * t)
    for (const sgn of [-1, 1]) {
      const lat = sgn * (HALF_WIDTH + 2.4)
      const pts: Vector3[] = []
      for (let k = 0; k <= 40; k++) {
        const t = k / 40
        const p = track.sample(s0 + (s1 - s0) * t, lat)
        pts.push(new Vector3(p.x, archY(t), p.z))
      }
      const curve = new CatmullRomCurve3(pts)
      bridgeGeos.push(new TubeGeometry(curve, 80, 0.42, 10))
      const neonPts = pts.map((v) => v.clone().add(new Vector3(0, 0.5, 0)))
      neonArch.push({ g: new TubeGeometry(new CatmullRomCurve3(neonPts), 80, 0.09, 6), c: hue })
      // Ванты от арки к пролёту
      for (let k = 2; k < 40; k += 2) {
        const t = k / 40
        const p = track.sample(s0 + (s1 - s0) * t, lat)
        const h = archY(t)
        bridgeGeos.push(new CylinderGeometry(0.05, 0.05, h, 5).translate(p.x, h / 2 + 0.1, p.z))
      }
      // Опоры арок на берегах
      for (const t of [0, 1]) {
        const p = track.sample(s0 + (s1 - s0) * t, lat)
        bridgeGeos.push(new BoxGeometry(1.6, 3, 1.6).translate(p.x, 1.4, p.z))
      }
    }
    // Поперечные связи над дорогой
    for (const t of [0.32, 0.5, 0.68]) {
      const a = track.sample(s0 + (s1 - s0) * t, HALF_WIDTH + 2.4)
      const b = track.sample(s0 + (s1 - s0) * t, -(HALF_WIDTH + 2.4))
      const y = archY(t)
      const len = Math.hypot(a.x - b.x, a.z - b.z)
      const g = new BoxGeometry(len, 0.4, 0.4)
      g.rotateY(Math.atan2(-(b.z - a.z), b.x - a.x))
      g.translate((a.x + b.x) / 2, y, (a.z + b.z) / 2)
      bridgeGeos.push(g)
    }
    // Быки в воде
    for (const off of [-RIVER.halfWidth * 0.45, RIVER.halfWidth * 0.45]) {
      const p = track.sample(idx + off)
      const h = -RIVER.water
      const g = new BoxGeometry(HALF_WIDTH * 2 + 6, h, 2.4)
      g.rotateY(Math.atan2(p.tx, p.tz))
      g.translate(p.x, RIVER.water + h / 2 - 1.6 + 0.01, p.z)
      pierGeos.push(g)
    }
  })
  if (bridgeGeos.length) {
    root.add(new Mesh(mergeGeometries(bridgeGeos.map((g) => (g.index ? g.toNonIndexed() : g))), steelMat))
    root.add(new Mesh(mergeGeometries(pierGeos), deckMat))
    const archMat = new MeshBasicNodeMaterial({ vertexColors: true })
    archMat.colorNode = attribute('color', 'vec3').mul(float(5).add(sin(time.mul(2.0)).mul(1.0)))
    root.add(new Mesh(mergeGeometries(neonArch.map(({ g, c }) => paint(g, c))), archMat))
  }

  /* ---------- Тоннель ---------- */
  {
    const from = TUNNEL.from
    const to = TUNNEL.to
    const H = TUNNEL.height
    const W = HALF_WIDTH + 1.2
    const innerMat = new MeshStandardNodeMaterial({ side: DoubleSide })
    {
      const a = uv().x as N // длина по профилю от левого низа
      const s = uv().y as N
      const tile = vec2(a.div(0.6), s.div(0.6))
      const grout = step(0.06, fract(tile.x)).mul(step(0.06, fract(tile.y)))
      // Длины по профилю: стена, фаска, свод, фаска, стена
      const wallLen = H - 0.8 - 0.16
      const total = wallLen * 2 + Math.hypot(1, 0.8) * 2 + (W - 1) * 2
      // Неоновые линии вдоль стен: голубая внизу, розовая под сводом
      const lineA = exp(a.sub(1.1).pow(2).mul(-300)).add(exp(a.sub(total - 1.1).pow(2).mul(-300)))
      const lineB = exp(a.sub(wallLen - 0.4).pow(2).mul(-300)).add(exp(a.sub(total - wallLen + 0.4).pow(2).mul(-300)))
      const lamp = exp(fract(s.div(10)).sub(0.5).mul(10).pow(2).mul(-0.08))
      innerMat.colorNode = mix(color('#2a2832'), color('#4a4652'), grout)
      innerMat.roughnessNode = float(0.25)
      innerMat.emissiveNode = color('#ffae5c')
        .mul(lamp.mul(0.12).add(0.05))
        .mul(grout.mul(0.6).add(0.4))
        .add(color('#2bf0ff').mul(lineA).mul(4))
        .add(color('#ff2bd6').mul(lineB).mul(4))
    }
    innerMat.lightsNode = lights([])
    const innerProfile: Array<[number, number]> = [
      [W, 0.16],
      [W, H - 0.8],
      [W - 1, H],
      [-(W - 1), H],
      [-W, H - 0.8],
      [-W, 0.16],
    ]
    root.add(new Mesh(sweep(track, innerProfile, 0, 2, from, to), innerMat))

    const shellMat = new MeshStandardNodeMaterial({ side: DoubleSide })
    {
      const p = positionWorld as N
      const n = mx_fractal_noise_float(vec3(p.xz.mul(0.08), 2.0), 3).mul(0.5).add(0.5)
      shellMat.colorNode = mix(color('#08090c'), color('#14161c'), n)
      shellMat.roughnessNode = float(0.4)
      shellMat.emissiveNode = color('#120c22').mul(0.6)
    }
    shellMat.lightsNode = lights([])
    const shellProfile: Array<[number, number]> = [
      [16.5, -0.05],
      [12, H + 1.6],
      [-12, H + 1.6],
      [-16.5, -0.05],
    ]
    root.add(new Mesh(sweep(track, shellProfile, 0, 2, from, to), shellMat))

    // Порталы: стена по форме насыпи с проёмом под дорогу и неоновой вывеской
    const portalShape = new Shape()
    portalShape.moveTo(-16.5, -0.05)
    portalShape.lineTo(16.5, -0.05)
    portalShape.lineTo(12, H + 1.6)
    portalShape.lineTo(-12, H + 1.6)
    portalShape.closePath()
    const hole = new Path()
    hole.moveTo(-W, 0)
    hole.lineTo(W, 0)
    hole.lineTo(W, H - 0.8)
    hole.lineTo(W - 1, H)
    hole.lineTo(-(W - 1), H)
    hole.lineTo(-W, H - 0.8)
    hole.closePath()
    portalShape.holes.push(hole)
    const portalGeo = new ExtrudeGeometry(portalShape, { depth: 1.2, bevelEnabled: false })
    for (const [sAt, dir] of [
      [from, 1],
      [to, -1],
    ] as const) {
      const p = track.sample(sAt)
      const portal = new Mesh(portalGeo, shellMat)
      portal.position.set(p.x, 0, p.z)
      // Локальная x портала — поперёк трассы, z — вдоль
      portal.rotation.y = Math.atan2(p.tx, p.tz) + (dir > 0 ? Math.PI : 0)
      portal.translateZ(-0.6)
      root.add(portal)
      const sign = new Mesh(signPlane(TUNNEL_SIGN, 9, 2.25), signMat)
      sign.position.set(p.x, H + 0.5, p.z)
      sign.rotation.y = Math.atan2(p.tx, p.tz) + (dir > 0 ? Math.PI : 0)
      sign.translateZ(1.4)
      root.add(sign)
    }

    // Светильники под сводом
    const fixtures: BufferGeometry[] = []
    for (let sAt = from + 5; sAt < to; sAt += 10) {
      for (const lat of [-4, 4]) {
        const p = track.sample(sAt, lat)
        const g = new BoxGeometry(0.5, 0.12, 2.4)
        g.rotateY(Math.atan2(p.tx, p.tz))
        g.translate(p.x, H - 0.08, p.z)
        fixtures.push(g)
        lampPositions.push(new Vector3(p.x, H - 0.4, p.z))
        lampColors.push(new Color('#ffae5c'))
      }
    }
    const fixMat = new MeshBasicNodeMaterial()
    fixMat.colorNode = color('#ffc27a').mul(7)
    root.add(new Mesh(mergeGeometries(fixtures), fixMat))
  }

  /* ---------- Арка старта ---------- */
  {
    const p = track.sample(0)
    const yaw = Math.atan2(p.tx, p.tz)
    const arch = new Group()
    const pillarMat = new MeshStandardNodeMaterial({ color: '#15151c', roughness: 0.35, metalness: 0.7 })
    for (const s of [-1, 1]) {
      const pillar = new Mesh(new BoxGeometry(1.2, 9, 1.2), pillarMat)
      pillar.position.set(s * (HALF_WIDTH + 1.6), 4.5, 0)
      arch.add(pillar)
    }
    const beam = new Mesh(new BoxGeometry(ROAD_SPAN, 1.8, 1.0), pillarMat)
    beam.position.set(0, 8.4, 0)
    arch.add(beam)
    const signG = new PlaneGeometry(12, 1.6)
    const { u0, u1, v0, v1 } = signUV(3)
    const uvA = signG.getAttribute('uv') as BufferAttribute
    for (let k = 0; k < uvA.count; k++) uvA.setXY(k, uvA.getX(k) ? u1 : u0, uvA.getY(k) ? v1 - 0.06 : v0 + 0.06)
    const signM = new MeshBasicNodeMaterial({ side: DoubleSide })
    signM.colorNode = texture(atlas, uv()).rgb.mul(5)
    const sign = new Mesh(signG, signM)
    sign.position.set(0, 8.4, 0.52)
    const sign2 = sign.clone()
    sign2.position.z = -0.52
    sign2.rotation.y = Math.PI
    arch.add(sign, sign2)
    const stripMat = new MeshBasicNodeMaterial()
    stripMat.colorNode = mix(color('#ff2bd6'), color('#2bf0ff'), step(0.5, fract(time.mul(0.8)))).mul(6)
    const strip = new Mesh(new BoxGeometry(ROAD_SPAN, 0.12, 1.06), stripMat)
    strip.position.set(0, 7.45, 0)
    arch.add(strip)
    arch.position.set(p.x, 0, p.z)
    // Локальная ось x арки — поперёк трассы
    arch.rotation.y = yaw
    root.add(arch)
  }

  /* ---------- Фары: единственные настоящие источники для дороги ---------- */
  const headlights: SpotLight[] = []
  for (const s of [-1, 1]) {
    const l = new SpotLight('#eaf2ff', 260, 90, Math.PI / 7, 0.55, 1.6)
    l.userData.side = s
    headlights.push(l)
    scene.add(l, l.target)
  }
  const roadLights = lights(headlights)
  roadMat.lightsNode = roadLights
  walkMat.lightsNode = roadLights
  barrierMat.lightsNode = roadLights
  groundMat.lightsNode = roadLights
  poleMat.lightsNode = roadLights

  return { root, lampSpacing, syncReflection, reflector: reflection.reflector, headlights, lampPositions, lampColors, buildingCount: buildings.length }
}

const ROAD_SPAN = HALF_WIDTH * 2 + 4.4

/** Плоскость вывески с UV из атласа; aFlick = 0 — без мерцания */
function signPlane(index: number, w: number, h: number, flick = 0) {
  const g = new PlaneGeometry(w, h)
  const { u0, u1, v0, v1 } = signUV(index)
  const uvA = g.getAttribute('uv') as BufferAttribute
  for (let k = 0; k < uvA.count; k++) uvA.setXY(k, uvA.getX(k) ? u1 : u0, uvA.getY(k) ? v1 : v0)
  g.setAttribute('aFlick', new BufferAttribute(new Float32Array(uvA.count).fill(flick), 1))
  return g
}

/** Красит геометрию в один цвет через атрибут color (для неона, который рисуется одним мешем) */
function paint(g: BufferGeometry, c: Color) {
  const geo = g.index ? g.toNonIndexed() : g
  const cols = new Float32Array(geo.getAttribute('position').count * 3)
  for (let k = 0; k < cols.length; k += 3) {
    cols[k] = c.r
    cols[k + 1] = c.g
    cols[k + 2] = c.b
  }
  geo.setAttribute('color', new BufferAttribute(cols, 3))
  geo.deleteAttribute('uv')
  geo.deleteAttribute('normal')
  return geo
}
