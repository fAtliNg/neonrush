import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  SphereGeometry,
} from 'three/webgpu'
import { attribute, color, float, lights, mix, select } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { HALF_WIDTH, Track } from './track'
import { bridgeCrossings, inTunnel } from './features'
import { rng } from './world'

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any

/** Части фигуры: цвет и «материал» (0 — кожа/ткань, 1 — латекс с бликом, 2 — светящийся экран телефона) */
interface Part {
  g: BufferGeometry
  c: Color
  kind: number
}

const SKIN = ['#f1c9a8', '#d9a07a', '#a8714e', '#6e4630', '#f6d6c0']
const HAIR = ['#f3d27a', '#1a1214', '#7a3b1e', '#ff4fd8', '#c9c9d6', '#3a2a8a']
const OUTFIT = ['#ff2b6a', '#ff2bd6', '#8b2bff', '#e8102a', '#111116', '#2bf0ff', '#f2f2f8']

function tint(g: BufferGeometry, c: Color, kind: number): Part {
  return { g, c, kind }
}

/** Низкополигональная фигура ~1,7 м, лицом к +z. Без наготы: мини-юбка или шорты, топ, сапоги или туфли на каблуке. */
function buildFigure(rand: () => number) {
  const skin = new Color(SKIN[Math.floor(rand() * SKIN.length)])
  const hair = new Color(HAIR[Math.floor(rand() * HAIR.length)])
  const outfit = new Color(OUTFIT[Math.floor(rand() * OUTFIT.length)])
  const second = new Color(OUTFIT[Math.floor(rand() * OUTFIT.length)])
  const boots = rand() < 0.55
  const shorts = rand() < 0.3
  const jacket = rand() < 0.35
  const parts: Part[] = []

  // Ноги: правая опорная, левая чуть отставлена
  for (const [x, ang] of [
    [0.085, 0.02],
    [-0.1, -0.09],
  ] as const) {
    const leg = new CylinderGeometry(0.075, 0.05, 0.8, 8).translate(0, 0.48, 0).rotateZ(ang)
    leg.translate(x, 0, 0)
    parts.push(tint(leg, skin, 0))
    if (boots) {
      const boot = new CylinderGeometry(0.062, 0.052, 0.45, 8).translate(0, 0.3, 0).rotateZ(ang)
      boot.translate(x, 0, 0)
      parts.push(tint(boot, second, 1))
    }
    // Туфля на каблуке: носок вперёд, тонкий каблук сзади
    const toe = new BoxGeometry(0.08, 0.05, 0.16).translate(x + Math.sin(ang) * 0.06, 0.06, 0.05)
    const heel = new CylinderGeometry(0.012, 0.012, 0.1, 4).translate(x + Math.sin(ang) * 0.08, 0.05, -0.05)
    parts.push(tint(toe, second, 1), tint(heel, second, 1))
  }

  // Юбка или шорты
  if (shorts) {
    parts.push(tint(new CylinderGeometry(0.15, 0.16, 0.13, 10).translate(0, 0.9, 0), outfit, 1))
  } else {
    parts.push(tint(new CylinderGeometry(0.14, 0.2, 0.2, 12).translate(0, 0.87, 0), outfit, 1))
  }

  // Талия открыта, топ
  parts.push(tint(new CylinderGeometry(0.115, 0.135, 0.16, 10).translate(0, 1.04, 0), skin, 0))
  parts.push(tint(new CylinderGeometry(0.15, 0.12, 0.22, 10).translate(0, 1.23, 0).scale(1, 1, 0.8), outfit, 1))
  parts.push(tint(new SphereGeometry(0.085, 8, 6).translate(0.06, 1.25, 0.07), outfit, 1))
  parts.push(tint(new SphereGeometry(0.085, 8, 6).translate(-0.06, 1.25, 0.07), outfit, 1))
  // Плечи и шея
  parts.push(tint(new CylinderGeometry(0.16, 0.15, 0.08, 10).translate(0, 1.38, 0).scale(1, 1, 0.75), skin, 0))
  parts.push(tint(new CylinderGeometry(0.04, 0.045, 0.1, 6).translate(0, 1.46, 0), skin, 0))

  // Руки: левая вдоль тела с сумочкой, правая на бедре
  const armColor = jacket ? second : skin
  const armKind = jacket ? 1 : 0
  const upperL = new CylinderGeometry(0.04, 0.035, 0.3, 6).translate(0, -0.15, 0).rotateZ(-0.12)
  upperL.translate(-0.19, 1.38, 0)
  const foreL = new CylinderGeometry(0.035, 0.03, 0.28, 6).translate(0, -0.14, 0).rotateZ(0.05)
  foreL.translate(-0.225, 1.09, 0)
  parts.push(tint(upperL, armColor, armKind), tint(foreL, skin, 0))
  parts.push(tint(new BoxGeometry(0.16, 0.11, 0.06).translate(-0.24, 0.8, 0), second, 1))
  // Локоть в сторону, кисть возвращается к бедру
  const upperR = new CylinderGeometry(0.04, 0.035, 0.28, 6).translate(0, -0.14, 0).rotateZ(0.55)
  upperR.translate(0.18, 1.38, 0)
  const foreR = new CylinderGeometry(0.035, 0.03, 0.23, 6).translate(0, -0.115, 0).rotateZ(-0.8)
  foreR.translate(0.326, 1.14, 0)
  parts.push(tint(upperR, armColor, armKind), tint(foreR, skin, 0))
  // Телефон в руке у некоторых — светится
  if (rand() < 0.4) parts.push(tint(new BoxGeometry(0.05, 0.09, 0.01).translate(-0.22, 0.86, 0.06), new Color('#9fd8ff'), 2))

  // Голова и волосы
  parts.push(tint(new SphereGeometry(0.1, 10, 8).scale(0.9, 1.08, 0.95).translate(0, 1.6, 0.01), skin, 0))
  parts.push(tint(new SphereGeometry(0.11, 10, 8).scale(1, 1.05, 1).translate(0, 1.63, -0.025), hair, 0))
  const longHair = rand() < 0.75
  if (longHair) parts.push(tint(new BoxGeometry(0.21, 0.32, 0.08).translate(0, 1.44, -0.08), hair, 0))
  // Губы — маленький яркий акцент
  parts.push(tint(new BoxGeometry(0.035, 0.012, 0.01).translate(0, 1.55, 0.098), new Color('#e8102a'), 1))

  // Сливаем всё в одну геометрию с цветом и типом материала в атрибутах
  const geos = parts.map(({ g, c, kind }) => {
    const geo = g.index ? g.toNonIndexed() : g
    const n = geo.getAttribute('position').count
    const cols = new Float32Array(n * 3)
    const kinds = new Float32Array(n).fill(kind)
    for (let i = 0; i < n; i++) {
      cols[i * 3] = c.r
      cols[i * 3 + 1] = c.g
      cols[i * 3 + 2] = c.b
    }
    geo.setAttribute('color', new BufferAttribute(cols, 3))
    geo.setAttribute('aKind', new BufferAttribute(kinds, 1))
    geo.deleteAttribute('uv')
    return geo
  })
  return mergeGeometries(geos)
}

/**
 * Девушки у фонарей на тротуарах — редкие, по одной-две. Стоят за отбойником, машины до них не достают.
 * Возвращает функцию анимации: лёгкое покачивание и переминание.
 */
export function createStreetGirls(track: Track, lampSpacing: number) {
  const rand = rng(777)
  const group = new Group()
  const L = track.length
  const bridges = bridgeCrossings(track)
  const nearBridge = (s: number) => bridges.some((b) => Math.abs(((s - b + L * 1.5) % L) - L / 2) < 45)

  const mat = new MeshStandardNodeMaterial({ vertexColors: true })
  {
    const c = attribute('color', 'vec3') as N
    const kind = attribute('aKind', 'float') as N
    const latex = select(kind.greaterThan(0.5), float(1), float(0))
    const screen = select(kind.greaterThan(1.5), float(1), float(0))
    mat.colorNode = c
    mat.roughnessNode = mix(0.7, 0.18, latex)
    mat.metalnessNode = mix(0.0, 0.25, latex)
    // Ночью их освещают фонари рядом — имитируем мягким самосвечением, экран телефона светится сам
    mat.emissiveNode = c.mul(0.22).add(color('#9fd8ff').mul(screen).mul(3))
  }
  mat.lightsNode = lights([])

  const figures: Array<{ mesh: Mesh; base: number; phase: number }> = []
  const lampCount = Math.round(L / lampSpacing)
  for (let k = 3; k < lampCount; k += 7 + Math.floor(rand() * 4)) {
    const sLamp = k * lampSpacing
    if (inTunnel(sLamp, L, 25) || nearBridge(sLamp)) continue
    // Фонари стоят по очереди слева и справа: встаём к своему
    const side = k % 2 === 0 ? 1 : -1
    const count = rand() < 0.45 ? 2 : 1
    for (let i = 0; i < count; i++) {
      const s = sLamp + (i === 0 ? -1.2 : 1.1) + (rand() - 0.5) * 0.6
      const p = track.sample(s, side * (HALF_WIDTH + 2.3 + rand() * 1.4))
      const mesh = new Mesh(buildFigure(rand), mat)
      // Лицом к дороге, чуть вполоборота
      const base = Math.atan2(-p.tz * side, p.tx * side) + (rand() - 0.5) * 0.8
      mesh.position.set(p.x, 0.16, p.z)
      mesh.rotation.y = base
      group.add(mesh)
      figures.push({ mesh, base, phase: rand() * 10 })
    }
  }

  const update = (time: number) => {
    for (const f of figures) {
      // Переминается с ноги на ногу и иногда поворачивается к проезжающим
      const t = time * 0.9 + f.phase
      f.mesh.rotation.y = f.base + Math.sin(t * 0.37) * 0.25
      f.mesh.rotation.z = Math.sin(t) * 0.025
      f.mesh.position.y = 0.16 + Math.abs(Math.sin(t)) * 0.01
    }
  }
  return { group, update, count: figures.length }
}

