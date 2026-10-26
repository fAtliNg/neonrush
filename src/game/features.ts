import { DataTexture, LinearFilter, RedFormat, UnsignedByteType } from 'three/webgpu'
import { Track } from './track'

/**
 * Особые места трассы. Река — прямая полоса через весь город, трасса пересекает её дважды по мостам.
 * Линия подобрана так, чтобы оба пересечения пришлись на прямые участки почти под прямым углом.
 */
export const RIVER = {
  /** Нормаль к руслу (x, z) и смещение: точки русла удовлетворяют |n·p − c| < halfWidth */
  nx: Math.cos((174 * Math.PI) / 180),
  nz: Math.sin((174 * Math.PI) / 180),
  c: -100,
  halfWidth: 22,
  /** Уровень воды и глубина набережной */
  water: -3.2,
}

/** Тоннель: участок трассы, s в метрах */
export const TUNNEL = { from: 1240, to: 1450, height: 6.4 }

export function riverDistance(x: number, z: number) {
  return x * RIVER.nx + z * RIVER.nz - RIVER.c
}

export function inTunnel(s: number, length: number, margin = 0) {
  const t = ((s % length) + length) % length
  return t > TUNNEL.from - margin && t < TUNNEL.to + margin
}

/** Пересечения трассы с рекой (индексы точек) — середины мостов */
export function bridgeCrossings(track: Track) {
  const out: number[] = []
  for (let i = 0; i < track.count; i++) {
    const a = track.at(i)
    const b = track.at(i + 1)
    if (riverDistance(a.x, a.z) * riverDistance(b.x, b.z) < 0) out.push(i)
  }
  return out
}

/** Разделители по оси дороги: s от и до, м */
export const DIVIDERS: Array<{ from: number; to: number }> = [
  { from: 380, to: 470 },
  { from: 1690, to: 1790 },
  { from: 2190, to: 2280 },
]
export const DIVIDER_HALF = 0.35

/** Порталы с указателями над дорогой: их опоры стоят на асфальте и не сносятся */
export const GANTRIES = [620, 1580, 2060]

export function inDivider(s: number, length: number, margin = 0) {
  const t = ((s % length) + length) % length
  return DIVIDERS.some((d) => t > d.from - margin && t < d.to + margin)
}

/**
 * Карта тоннеля сверху: 1 — под сводом. По ней дождь гасит каждую каплю отдельно,
 * поэтому у порталов снаружи капли есть, а внутри нет.
 */
export function tunnelMask(track: Track, res = 256) {
  const pts: Array<{ x: number; z: number; nx: number; nz: number }> = []
  for (let s = TUNNEL.from; s <= TUNNEL.to; s += 1) pts.push(track.at(s))
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z)
    maxZ = Math.max(maxZ, p.z)
  }
  const pad = 20
  minX -= pad
  minZ -= pad
  const size = Math.max(maxX - minX, maxZ - minZ) + pad
  const data = new Uint8Array(res * res)
  const halfIn = 9.2 // внутренняя стена тоннеля от оси
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = minX + ((i + 0.5) / res) * size
      const z = minZ + ((j + 0.5) / res) * size
      let best = Infinity
      let k = 0
      for (let n = 0; n < pts.length; n += 2) {
        const d = (pts[n].x - x) ** 2 + (pts[n].z - z) ** 2
        if (d < best) {
          best = d
          k = n
        }
      }
      // Внутри — если близко к оси и не за торцами
      const inside = Math.sqrt(best) < halfIn + 0.5 && k > 0 && k < pts.length - 2
      data[j * res + i] = inside ? 255 : 0
    }
  }
  const texture = new DataTexture(data, res, res, RedFormat, UnsignedByteType)
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.needsUpdate = true
  return { texture, minX, minZ, size }
}
