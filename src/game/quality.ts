export type QualityLevel = 'ultra' | 'high' | 'low'

export interface Quality {
  level: QualityLevel
  pixelRatio: number
  /** Масштаб текстуры отражения мокрого асфальта */
  reflection: number
  /** MSAA основного прохода */
  samples: number
  rain: number
  motionBlur: boolean
  volumetric: boolean
  bloom: boolean
}

export function getQuality(level: QualityLevel): Quality {
  const q = baseQuality(level)
  // Отладка: ?debug=nobloom,nomb
  const debug = new URLSearchParams(location.search).get('debug') ?? ''
  if (debug.includes('nobloom')) q.bloom = false
  if (debug.includes('nomb')) q.motionBlur = false
  if (debug.includes('novol')) q.volumetric = false
  return q
}

function baseQuality(level: QualityLevel): Quality {
  const dpr = window.devicePixelRatio || 1
  switch (level) {
    case 'ultra':
      return { level, pixelRatio: Math.min(dpr, 2), reflection: 0.75, samples: 4, rain: 14000, motionBlur: true, volumetric: true, bloom: true }
    case 'high':
      return { level, pixelRatio: Math.min(dpr, 1.5), reflection: 0.5, samples: 4, rain: 9000, motionBlur: true, volumetric: true, bloom: true }
    default:
      return { level, pixelRatio: 1, reflection: 0.3, samples: 0, rain: 3000, motionBlur: false, volumetric: false, bloom: true }
  }
}

export function defaultQualityLevel(): QualityLevel {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches
  return coarse ? 'low' : 'high'
}
