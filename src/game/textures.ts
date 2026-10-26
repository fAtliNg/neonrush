import { CanvasTexture, DataTexture, LinearFilter, RGBAFormat, SRGBColorSpace, Color } from 'three/webgpu'

/** Тексты вывесок. Атлас 4×4 ячейки, каждая — светящаяся надпись на тёмной подложке. */
export const SIGNS: Array<{ text: string; color: string; second?: string; font?: string }> = [
  { text: 'NEON', color: '#ff2bd6', second: '#3cf2ff' },
  { text: 'БАР 24', color: '#ffb02e' },
  { text: 'ОТЕЛЬ', color: '#3cf2ff' },
  { text: 'RUSH', color: '#ff3b5c', second: '#ffd23c' },
  { text: 'ТУРБО', color: '#8b5cff' },
  { text: 'КИНО', color: '#ff2bd6' },
  { text: 'ラーメン', color: '#ff5a2b', font: 'sans-serif' },
  { text: 'АПТЕКА', color: '#2bff9a' },
  { text: 'DRIFT', color: '#3cf2ff', second: '#ff2bd6' },
  { text: 'КАФЕ', color: '#ffd23c' },
  { text: 'ГАРАЖ', color: '#ff3b5c' },
  { text: '夜', color: '#ff2bd6', font: 'sans-serif' },
  { text: 'НОЧЬ', color: '#8b5cff', second: '#3cf2ff' },
  { text: 'SUSHI', color: '#ff7a2b' },
  { text: 'КЛУБ', color: '#2bc8ff' },
  { text: 'OPEN', color: '#ff2b4f' },
  { text: 'ТОННЕЛЬ', color: '#ffae5c', second: '#2bf0ff' },
  { text: 'ЛОМБАРД', color: '#ffd23c' },
  { text: 'ТАКСИ', color: '#ffd23c', second: '#ff3b5c' },
  { text: 'ХОСТЕЛ', color: '#2bff9a', second: '#ff2bd6' },
]

/** Номер вывески «ТОННЕЛЬ» в атласе — для порталов */
export const TUNNEL_SIGN = 16
/** Вывески для городских кварталов (без служебных) */
export const CITY_SIGNS = SIGNS.length

const ROWS = Math.ceil(SIGNS.length / 4)

const CELL = 512

export async function createSignAtlas() {
  try {
    await document.fonts.load('900 120px Orbitron')
    await document.fonts.load('700 120px Onest')
  } catch {
    /* шрифты не загрузились — нарисуем системными */
  }
  const canvas = document.createElement('canvas')
  canvas.width = CELL * 4
  canvas.height = (CELL / 2) * ROWS
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  SIGNS.forEach((sign, i) => {
    // Ячейка 512×256: вывески вытянуты по горизонтали
    const cx = (i % 4) * CELL
    const cy = Math.floor(i / 4) * (CELL / 2)
    const w = CELL
    const h = CELL / 2
    ctx.save()
    ctx.beginPath()
    ctx.rect(cx, cy, w, h)
    ctx.clip()

    // Подложка с лёгким цветным отсветом
    const bg = ctx.createRadialGradient(cx + w / 2, cy + h / 2, 10, cx + w / 2, cy + h / 2, w * 0.6)
    bg.addColorStop(0, hexAlpha(sign.color, 0.16))
    bg.addColorStop(1, 'rgba(0,0,0,1)')
    ctx.fillStyle = bg
    ctx.fillRect(cx, cy, w, h)

    // Рамка-трубка
    ctx.strokeStyle = sign.second ?? sign.color
    ctx.lineWidth = 6
    ctx.shadowColor = sign.second ?? sign.color
    ctx.shadowBlur = 18
    roundRect(ctx, cx + 18, cy + 18, w - 36, h - 36, 26)
    ctx.stroke()

    const family = sign.font ?? (/[A-Z]/.test(sign.text) ? 'Orbitron' : 'Onest')
    let size = 150
    ctx.font = `900 ${size}px ${family}, sans-serif`
    while (ctx.measureText(sign.text).width > w - 110 && size > 40) {
      size -= 6
      ctx.font = `900 ${size}px ${family}, sans-serif`
    }
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // Несколько проходов: широкое свечение, затем яркая сердцевина трубки
    ctx.shadowColor = sign.color
    for (const [blur, alpha] of [
      [40, 0.9],
      [16, 1],
    ] as const) {
      ctx.shadowBlur = blur
      ctx.fillStyle = hexAlpha(sign.color, alpha)
      ctx.fillText(sign.text, cx + w / 2, cy + h / 2 + 6)
    }
    ctx.shadowBlur = 4
    ctx.fillStyle = mixWhite(sign.color, 0.55)
    ctx.fillText(sign.text, cx + w / 2, cy + h / 2 + 6)
    ctx.restore()
  })

  const tex = new CanvasTexture(canvas)
  tex.colorSpace = SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

/** UV-прямоугольник вывески i в атласе */
export function signUV(i: number) {
  const col = i % 4
  const row = Math.floor(i / 4)
  return { u0: col / 4, u1: (col + 1) / 4, v0: 1 - (row + 1) / ROWS, v1: 1 - row / ROWS }
}

/** Мягкое круглое пятно для частиц */
export function createSpriteTexture() {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  // Почти гауссово пятно: у частиц не должно быть заметного края
  for (let i = 0; i <= 10; i++) {
    const t = i / 10
    g.addColorStop(t, `rgba(255,255,255,${Math.exp(-t * t * 5) * (1 - t)})`)
  }
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new CanvasTexture(canvas)
  tex.minFilter = LinearFilter
  return tex
}

/** Цвета фонарей вдоль трассы: одна текстура 1×N, общая для мешей и шейдера асфальта */
export function createLampColors(count: number, palette: Color[]) {
  const data = new Uint8Array(count * 4)
  const colors: Color[] = []
  for (let i = 0; i < count; i++) {
    // Зоны по 8 фонарей одного цвета: кварталы отличаются светом
    const c = palette[Math.floor(i / 8) % palette.length]
    colors.push(c)
    data[i * 4] = Math.round(c.r * 255)
    data[i * 4 + 1] = Math.round(c.g * 255)
    data[i * 4 + 2] = Math.round(c.b * 255)
    data[i * 4 + 3] = 255
  }
  const tex = new DataTexture(data, count, 1, RGBAFormat)
  tex.needsUpdate = true
  return { texture: tex, colors }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function hexAlpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

function mixWhite(hex: string, t: number) {
  const n = parseInt(hex.slice(1), 16)
  const m = (c: number) => Math.round(c + (255 - c) * t)
  return `rgb(${m((n >> 16) & 255)},${m((n >> 8) & 255)},${m(n & 255)})`
}
