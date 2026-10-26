import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Color,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  RenderPipeline,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGPURenderer,
  BackSide,
  RenderTarget,
  PlaneGeometry,
  AdditiveBlending,
} from 'three/webgpu'
import {
  color,
  densityFogFactor,
  fog,
  hash,
  int,
  mrt,
  output,
  pass,
  renderOutput,
  screenUV,
  time,
  uniform,
  vec3,
  velocity,
  vec4,
  smoothstep,
  float,
  fract,
  uv,
} from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import { Track } from './track'
import { buildWorld } from './world'
import { buildCar, PLAYER_LIVERY, WHEEL_RADIUS } from './car'
import type { CarPhysics } from './physics'
import { BOTS, BotDriver, LAPS, Racer } from './race'
import { Obstacles } from './obstacles'
import { createStreetGirls } from './streetgirls'
import type { Controls } from './input'
import { Input } from './input'
import { CarAudio } from './audio'
import { attachLampLights, createRain, Particles } from './effects'
import { createSpriteTexture } from './textures'
import { getQuality, type QualityLevel } from './quality'
import { DIVIDERS, RIVER, TUNNEL, bridgeCrossings, tunnelMask } from './features'

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any

export interface HudState {
  speed: number
  gear: number
  rpm: number
  nitro: number
  nitroActive: boolean
  lap: number
  lapTime: number
  lastLap: number | null
  bestLap: number | null
  drift: number
  driftBank: number
  fps: number
  camera: string
  phase: RacePhase
  /** 3, 2, 1, 0 = «Старт!», null — отсчёта нет */
  countdown: number | null
  position: number
  racers: number
  laps: number
  raceTime: number
  cars: Array<{ x: number; z: number; color: string; me: boolean }>
  results: Array<{ name: string; time: number | null; best: number | null; me: boolean }> | null
}

export type RacePhase = 'grid' | 'countdown' | 'race' | 'finished'

export interface MinimapData {
  viewBox: string
  path: string
  tunnel: string
  river: [number, number, number, number]
  bridges: Array<[number, number]>
  dividers: string[]
  start: [number, number, number]
}

interface CarFx {
  roll: number
  pitch: number
  rollVel: number
  pitchVel: number
  lamps: (x: number, z: number) => void
}

const CAMERAS = ['Погоня', 'Близко', 'Дальняя', 'Бампер', 'ТВ-камеры'] as const
const BEST_KEY = 'neonrush:best'
const IDLE: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false }

export class Game {
  private renderer!: WebGPURenderer
  private scene = new Scene()
  private camera = new PerspectiveCamera(64, 1, 0.1, 3000)
  private pipeline!: RenderPipeline
  private track = new Track()
  private racers: Racer[] = []
  private player!: Racer
  private physics!: CarPhysics
  private fx = new Map<Racer, CarFx>()
  private obstacles!: Obstacles
  private phase: RacePhase = 'grid'
  private countdown = 0
  private raceClock = 0
  private input = new Input()
  private audio: CarAudio | null = null
  private headlights: any[] = []
  private syncReflection = () => {}
  private animateGirls: (t: number) => void = () => {}
  private particles!: Particles
  private rain!: ReturnType<typeof createRain>
  private uniforms = {
    carPos: uniform(new Vector2()),
    carDir: uniform(new Vector2(0, 1)),
    brake: uniform(0),
    underglow: uniform(1),
  }
  private blurAmount = uniform(0)
  private shake = 0
  private cut = 0
  private camMode = 0
  private camPos = new Vector3()
  private camLook = new Vector3()
  private camTarget = new Vector3()
  private camLookTarget = new Vector3()
  private tvCam = { pos: new Vector3(), until: -1 }
  private last = 0
  private running = false
  private disposed = false
  private paused = false
  private ro?: ResizeObserver

  private lastLap: number | null = null
  private bestLap: number | null = null
  private clock = 0
  private drift = 0
  private driftBank = 0
  private driftHold = 0

  private fpsFrames = 0
  private fpsTime = 0
  private fps = 0
  private hudTimer = 0

  backend = ''
  minimap: MinimapData | null = null
  onHud?: (s: HudState) => void
  onProgress?: (label: string, value: number) => void

  constructor(
    private container: HTMLElement,
    private qualityLevel: QualityLevel,
  ) {
    try {
      const b = localStorage.getItem(BEST_KEY)
      if (b) this.bestLap = Number(b) || null
    } catch {
      /* без localStorage рекорд просто не сохранится */
    }
    this.input.onCamera = () => (this.camMode = (this.camMode + 1) % CAMERAS.length)
    this.input.onReset = () => this.resetCar()
  }

  async init() {
    const q = getQuality(this.qualityLevel)
    this.onProgress?.('Запускаем видеокарту', 0.05)
    this.renderer = new WebGPURenderer({ antialias: false, powerPreference: 'high-performance' })
    await this.renderer.init()
    if (this.disposed) return
    this.backend = (this.renderer.backend as any).isWebGPUBackend ? 'WebGPU' : 'WebGL 2'
    this.renderer.setPixelRatio(q.pixelRatio)
    this.renderer.toneMapping = ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.container.appendChild(this.renderer.domElement)
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'

    /* Туман: фиолетовая городская дымка */
    ;(this.scene as any).fogNode = fog(color('#120c26'), densityFogFactor(float(0.0042)))

    /* Карта окружения для отражений на кузове: неоновая «комната» */
    this.onProgress?.('Готовим отражения', 0.15)
    const env = this.buildEnvironment()

    this.onProgress?.('Строим город', 0.3)
    const world = await buildWorld(this.scene, this.track, q, this.uniforms)
    if (this.disposed) return
    this.headlights = world.headlights
    this.camera.layers.enable(1)
    this.syncReflection = world.syncReflection
    // Камера отражения не должна видеть слой 1 — тротуары и землю, которые сами читают отражение
    const reflector = world.reflector
    const getVirtualCamera = reflector.getVirtualCamera.bind(reflector)
    reflector.getVirtualCamera = (cam: PerspectiveCamera) => {
      const vc = getVirtualCamera(cam)
      vc.layers.disable(1)
      return vc
    }

    const girls = createStreetGirls(this.track, world.lampSpacing)
    this.scene.add(girls.group)
    this.animateGirls = girls.update

    this.onProgress?.('Собираем машины', 0.55)
    this.obstacles = new Obstacles(this.track)
    this.scene.add(this.obstacles.group)
    const shadowMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
    {
      const d = uv().sub(0.5).mul(vec3(2.2, 1.25, 0).xy).length()
      shadowMat.colorNode = vec4(0, 0, 0, smoothstep(1.0, 0.45, d).mul(0.75))
    }
    const addCar = (name: string, livery = PLAYER_LIVERY, bot: BotDriver | null) => {
      const rig = buildCar(env, livery)
      this.scene.add(rig.root)
      rig.pointLights.forEach((l) => this.scene.add(l))
      if (bot) {
        // Под ботами — мягкая тень и цветной отсвет днища (у игрока это делает шейдер асфальта)
        const shadow = new Mesh(new PlaneGeometry(2.6, 5.4).rotateX(-Math.PI / 2), shadowMat)
        shadow.position.y = 0.03
        shadow.layers.set(1)
        rig.root.add(shadow)
        const glowMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending })
        const d = uv().sub(0.5).mul(vec3(2.4, 1.4, 0).xy).length()
        glowMat.colorNode = vec4(color(livery.glow).mul(smoothstep(1.0, 0.2, d).mul(0.5)), 1)
        const glow = new Mesh(new PlaneGeometry(3.2, 5.6).rotateX(-Math.PI / 2), glowMat)
        glow.position.y = 0.04
        glow.layers.set(1)
        rig.root.add(glow)
      }
      const r = new Racer(this.track, name, rig, livery.glow, bot)
      this.racers.push(r)
      this.fx.set(r, { roll: 0, pitch: 0, rollVel: 0, pitchVel: 0, lamps: attachLampLights(rig.pointLights, world.lampPositions, world.lampColors) })
      return r
    }
    // Игрок стартует в середине решётки
    const order = [0, 1, 2, -1, 3, 4]
    for (const k of order) {
      if (k < 0) this.player = addCar('Вы', PLAYER_LIVERY, null)
      else addCar(BOTS[k].name, BOTS[k].livery, new BotDriver(this.track, BOTS[k], k % 2 ? -4 : 4))
    }
    this.physics = this.player.physics
    this.minimap = this.buildMinimap()

    this.particles = new Particles(this.scene, createSpriteTexture())
    this.rain = createRain(this.scene, q.rain, { ...tunnelMask(this.track), height: TUNNEL.height })

    /* Постобработка */
    const scenePass = pass(this.scene, this.camera, { samples: q.samples } as any) as N
    scenePass.setMRT(mrt({ output, velocity }))
    const beauty = scenePass.getTextureNode('output')
    const vel = scenePass.getTextureNode('velocity')
    let hdr: N = q.motionBlur ? motionBlur(beauty, vel.mul(this.blurAmount), int(10)) : beauty
    if (q.bloom) hdr = hdr.add(bloom(beauty, 0.55, 0.45, 0.62))
    let ldr: N = renderOutput(hdr)
    const d = screenUV.sub(0.5).length()
    const vignette = smoothstep(0.85, 0.25, d).mul(0.45).add(0.55)
    const grain = hash(screenUV.x.mul(1931.7).add(screenUV.y.mul(1213.3)).add(fract(time).mul(97.0))).sub(0.5).mul(0.035)
    ldr = vec4(ldr.rgb.mul(vignette).add(grain).mul(vec3(1.0, 0.98, 1.03)), float(1))
    if (q.samples === 0) ldr = fxaa(ldr)
    this.pipeline = new RenderPipeline(this.renderer, ldr)
    this.pipeline.outputColorTransform = false

    this.placeGrid()
    this.snapCamera()
    this.resize()
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(this.container)

    this.onProgress?.('Компилируем шейдеры', 0.75)
    // Скрытые до поры эффекты (пламя нитро) тоже компилируем заранее, иначе первый нитро даёт рывок
    const hidden = this.racers.flatMap((r) => r.rig.flames)
    hidden.forEach((f) => (f.visible = true))
    await this.renderer.compileAsync(this.scene, this.camera)
    hidden.forEach((f) => (f.visible = false))
    if (this.disposed) return
    this.onProgress?.('Готово', 1)

    if (import.meta.env.DEV) {
      // Снимок кадра для отладки: WebGPU-канвас читается только в той же задаче, где был отрисован
      ;(window as any).__snap = async () => {
        // Рисуем в свою цель и читаем пиксели: канвас в фоновой вкладке может не обновиться
        const size = this.renderer.getDrawingBufferSize(new Vector2())
        const rt = new RenderTarget(size.x, size.y)
        this.renderer.setRenderTarget(rt)
        this.pipeline.render()
        this.renderer.setRenderTarget(null)
        const px = (await this.renderer.readRenderTargetPixelsAsync(rt, 0, 0, size.x, size.y)) as Uint8Array
        rt.dispose()
        const c = document.createElement('canvas')
        c.width = size.x
        c.height = size.y
        const ctx = c.getContext('2d')!
        const img = ctx.createImageData(size.x, size.y)
        const row = size.x * 4
        // WebGPU выравнивает строки до 256 байт
        const stride = px.length / size.y
        const flip = !(this.renderer.backend as any).isWebGPUBackend
        for (let y = 0; y < size.y; y++) {
          const src = (flip ? size.y - 1 - y : y) * stride
          img.data.set(px.subarray(src, src + row), y * row)
        }
        ctx.putImageData(img, 0, 0)
        return c.toDataURL('image/jpeg', 0.85)
      }
      ;(window as any).__game = this
    }

    this.running = true
    this.last = performance.now()
    this.renderer.setAnimationLoop(() => this.frame())
  }

  /** Звук можно создать только после клика пользователя */
  async startAudio() {
    if (!this.audio) this.audio = new CarAudio()
    await this.audio.resume()
  }

  setMuted(m: boolean) {
    this.audio?.setMuted(m)
  }

  setPaused(p: boolean) {
    this.paused = p
    this.last = performance.now()
  }

  resetCar() {
    if (this.phase === 'grid' || this.phase === 'countdown') return
    this.physics.place(this.physics.trackS)
    this.drift = 0
    this.snapCamera()
  }

  /** Отсчёт 3-2-1 и старт */
  startRace() {
    if (this.phase !== 'grid') return
    this.phase = 'countdown'
    this.countdown = 3
    this.audio?.beep(440, 0.18)
  }

  /** Новый заезд с решётки */
  restartRace() {
    this.placeGrid()
    this.obstacles.reset()
    this.drift = 0
    this.driftBank = 0
    this.snapCamera()
    this.phase = 'grid'
    this.startRace()
  }

  private placeGrid() {
    const L = this.track.length
    this.racers.forEach((r, i) => {
      // Две колонны, шаг 8 м, первая машина в 10 м перед линией
      const row = Math.floor(i / 2)
      const lat = i % 2 ? -3.4 : 3.4
      r.physics.place(L - 10 - row * 8 - (i % 2) * 3)
      const p = this.track.sample(L - 10 - row * 8 - (i % 2) * 3, lat)
      r.physics.x = p.x
      r.physics.z = p.z
      r.physics.nitro = 1
      r.crossings = -1
      r.lastS = L - 10
      r.halfway = false
      r.finishTime = null
      r.bestLap = null
      r.physics.trackIndex = -1
      r.physics.trackS = L - 10 - row * 8
    })
    this.raceClock = 0
    this.lastLap = null
    this.racers.forEach((r) => this.updateCarVisual(r, 0, 0))
  }

  private buildMinimap(): MinimapData {
    const pts = this.track.points
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
    const pad = 30
    const line = (from: number, to: number) => {
      let d = ''
      for (let i = from; i <= to; i += 6) {
        const p = this.track.at(i)
        d += `${d ? 'L' : 'M'}${p.x.toFixed(0)} ${p.z.toFixed(0)}`
      }
      return d
    }
    // Русло: отрезок прямой реки в пределах карты
    const dx = -RIVER.nz
    const dz = RIVER.nx
    const cx = RIVER.nx * RIVER.c
    const cz = RIVER.nz * RIVER.c
    const ext = 2000
    const s0 = this.track.sample(0)
    return {
      viewBox: `${minX - pad} ${minZ - pad} ${maxX - minX + pad * 2} ${maxZ - minZ + pad * 2}`,
      path: line(0, this.track.count) + 'Z',
      tunnel: line(TUNNEL.from, TUNNEL.to),
      river: [cx - dx * ext, cz - dz * ext, cx + dx * ext, cz + dz * ext],
      bridges: bridgeCrossings(this.track).map((i) => [this.track.at(i).x, this.track.at(i).z]),
      dividers: DIVIDERS.map((d) => line(d.from, d.to)),
      start: [s0.x, s0.z, (Math.atan2(s0.tx, s0.tz) * 180) / Math.PI],
    }
  }

  dispose() {
    this.disposed = true
    this.running = false
    this.renderer?.setAnimationLoop(null)
    this.ro?.disconnect()
    this.input.dispose()
    this.audio?.dispose()
    this.renderer?.dispose()
    this.renderer?.domElement.remove()
  }

  private buildEnvironment() {
    const envScene = new Scene()
    const room = new Mesh(new SphereGeometry(50, 32, 16), new MeshBasicNodeMaterial({ side: BackSide }))
    ;(room.material as any).colorNode = color('#05040b')
    envScene.add(room)
    const panel = (c: string, k: number, pos: [number, number, number], size: [number, number, number]) => {
      const m = new MeshBasicNodeMaterial()
      m.colorNode = color(c).mul(k)
      const mesh = new Mesh(new BoxGeometry(...size), m)
      mesh.position.set(...pos)
      envScene.add(mesh)
    }
    // Ряд фонарей над головой, неон по бокам, отсвет асфальта снизу
    for (let i = -3; i <= 3; i++) panel('#ffc890', 6, [i * 12, 22, 0], [2, 0.5, 6])
    panel('#ff2bd6', 4, [-38, 6, -10], [1, 14, 30])
    panel('#2bf0ff', 4, [38, 6, 10], [1, 14, 30])
    panel('#ff8a3c', 2.5, [0, 8, -42], [40, 6, 1])
    panel('#6a5cff', 2.5, [0, 10, 42], [40, 8, 1])
    panel('#1a1530', 1, [0, -6, 0], [100, 1, 100])
    const pmrem = new PMREMGenerator(this.renderer)
    const rt = pmrem.fromScene(envScene, 0.03)
    return rt.texture
  }

  private resize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private snapCamera() {
    const p = this.physics
    const fx = Math.sin(p.heading)
    const fz = Math.cos(p.heading)
    this.camPos.set(p.x - fx * 7, 2.4, p.z - fz * 7)
    this.camLook.set(p.x + fx * 4, 0.9, p.z + fz * 4)
    this.cut = 2
    // Сразу ставим и саму камеру: до старта кадры рисуются без updateCamera
    this.camera.position.copy(this.camPos)
    this.camera.lookAt(this.camLook)
  }

  private frame() {
    if (!this.running) return
    const now = performance.now()
    let dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    if (this.paused) dt = 0

    this.fpsFrames++
    this.fpsTime += (now - (this.fpsLast || now)) / 1000
    this.fpsLast = now
    if (this.fpsTime > 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsTime)
      this.fpsFrames = 0
      this.fpsTime = 0
    }

    const controls = this.input.read(dt)
    // Шаги физики делят время кадра поровну (не длиннее 1/120 с): позиция машины всегда соответствует моменту кадра, без рывков
    const substeps = Math.max(1, Math.ceil(dt * 120 - 1e-6))
    const STEP = dt / substeps
    const frozen = this.phase === 'grid' || this.phase === 'countdown'
    let impact = 0
    let hitPoint: { x: number; z: number } | null = null
    if (dt > 0 && this.phase === 'countdown') {
      const before = Math.ceil(this.countdown)
      this.countdown -= dt
      const after = Math.ceil(this.countdown)
      if (after !== before) this.audio?.beep(after <= 0 ? 880 : 440, after <= 0 ? 0.45 : 0.18)
      if (this.countdown <= 0) {
        this.phase = 'race'
        this.countdown = -1
        this.raceClock = 0
      }
    }
    if (frozen) {
      // На решётке можно погазовать на месте
      const p = this.physics
      p.rpm += (1000 + controls.throttle * 6500 - p.rpm) * Math.min(1, dt * 8)
      p.throttle = controls.throttle
    } else {
      const L = this.track.length
      const me = this.player.progress(L)
      const botControls = new Map<Racer, Controls>()
      for (const r of this.racers) {
        if (!r.bot) continue
        // Догонялки: отставшие боты чуть смелее, сильно убежавшие от игрока — чуть осторожнее
        const gap = r.progress(L) - me
        const catchUp = Math.max(0.86, Math.min(1.06, 1 - gap / 3000))
        botControls.set(
          r,
          r.bot.drive(
            r.physics,
            this.racers.filter((o) => o !== r).map((o) => o.physics),
            dt,
            this.phase === 'finished' && r.finishTime !== null ? 0.8 : catchUp,
          ),
        )
      }
      for (let n = 0; n < substeps && dt > 0; n++) {
        for (const r of this.racers) {
          const c = r.bot ? botControls.get(r)! : this.paused ? IDLE : controls
          const ev = r.physics.step(STEP, c)
          const hit = this.obstacles.collide(r.physics)
          if (r === this.player) {
            impact = Math.max(impact, ev.impact)
            if (hit && hit.impact > impact) {
              impact = hit.impact
              hitPoint = hit
            }
          }
        }
        impact = Math.max(impact, this.collideCars())
      }
    }
    if (dt > 0) {
      this.clock += dt
      if (!frozen) this.raceClock += dt
      this.updateLaps()
      this.updateDrift(dt, impact)
      for (const r of this.racers) this.updateCarVisual(r, dt, r === this.player ? controls.steer : 0)
      this.updatePlayerLights()
      this.obstacles.update(dt)
      this.animateGirls(this.clock)
      this.updateEffects(dt, impact, hitPoint)
      this.updateCamera(dt, impact)
      this.audio?.update({
        rpm: this.physics.rpm,
        throttle: controls.throttle,
        slip: this.physics.slip,
        speed: this.physics.speed,
        nitro: this.physics.nitroActive,
        drifting: this.physics.drifting,
      })
      if (impact > 0) this.audio?.impact(impact)
    }

    this.syncReflection()
    this.pipeline.render()

    this.hudTimer += dt
    if (this.hudTimer > 1 / 20 || dt === 0) {
      this.hudTimer = 0
      this.onHud?.({
        speed: Math.round(Math.abs(this.physics.forwardSpeed) * 3.6),
        gear: this.physics.gear,
        rpm: this.physics.rpm,
        nitro: this.physics.nitro,
        nitroActive: this.physics.nitroActive,
        lap: this.player.lap,
        lapTime: this.player.crossings >= 0 && this.player.finishTime === null ? this.raceClock - this.player.lapStart : 0,
        lastLap: this.lastLap,
        bestLap: this.bestLap,
        drift: Math.round(this.drift),
        driftBank: Math.round(this.driftBank),
        fps: this.fps,
        camera: CAMERAS[this.camMode],
        phase: this.phase,
        countdown: this.phase === 'countdown' ? Math.max(1, Math.ceil(this.countdown)) : this.phase === 'race' && this.raceClock < 1 ? 0 : null,
        position: this.standings().indexOf(this.player) + 1,
        racers: this.racers.length,
        laps: LAPS,
        raceTime: this.player.finishTime ?? this.raceClock,
        cars: this.racers.map((r) => ({ x: r.physics.x, z: r.physics.z, color: r.color, me: r === this.player })),
        results:
          this.phase === 'finished'
            ? this.standings().map((r) => ({ name: r.name, time: r.finishTime, best: r.bestLap, me: r === this.player }))
            : null,
      })
    }
  }
  private fpsLast = 0

  private updateLaps() {
    const L = this.track.length
    for (const r of this.racers) {
      const t = r.updateLap(L, this.raceClock)
      if (r !== this.player || t === null) continue
      this.lastLap = t
      if (this.bestLap === null || t < this.bestLap) {
        this.bestLap = t
        try {
          localStorage.setItem(BEST_KEY, String(t))
        } catch {
          /* не сохранили — не страшно */
        }
      }
    }
    if (this.phase === 'race' && this.player.finishTime !== null) this.phase = 'finished'
  }

  /** Места: финишировавшие по времени, остальные по пройденной дистанции */
  private standings() {
    const L = this.track.length
    return [...this.racers].sort((a, b) => {
      if (a.finishTime !== null && b.finishTime !== null) return a.finishTime - b.finishTime
      if (a.finishTime !== null) return -1
      if (b.finishTime !== null) return 1
      return b.progress(L) - a.progress(L)
    })
  }

  /** Машины — по два круга вдоль кузова; расталкиваем и обмениваемся импульсом */
  private collideCars() {
    const R = 0.98
    const OFF = 1.3
    let playerImpact = 0
    for (let i = 0; i < this.racers.length; i++) {
      for (let j = i + 1; j < this.racers.length; j++) {
        const a = this.racers[i].physics
        const b = this.racers[j].physics
        if (Math.abs(a.x - b.x) > 6 || Math.abs(a.z - b.z) > 6) continue
        for (const oa of [OFF, -OFF]) {
          for (const ob of [OFF, -OFF]) {
            const ax = a.x + Math.sin(a.heading) * oa
            const az = a.z + Math.cos(a.heading) * oa
            const bx = b.x + Math.sin(b.heading) * ob
            const bz = b.z + Math.cos(b.heading) * ob
            const dx = ax - bx
            const dz = az - bz
            const d = Math.hypot(dx, dz)
            if (d >= R * 2 || d < 1e-4) continue
            const nx = dx / d
            const nz = dz / d
            const pen = (R * 2 - d) / 2
            a.x += nx * pen
            a.z += nz * pen
            b.x -= nx * pen
            b.z -= nz * pen
            const rel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz
            if (rel < 0) {
              const j2 = -rel * 0.65
              a.vx += nx * j2
              a.vz += nz * j2
              b.vx -= nx * j2
              b.vz -= nz * j2
              // Удар в угол закручивает машину
              a.yawRate += Math.sign(oa) * (nx * Math.cos(a.heading) - nz * Math.sin(a.heading)) * j2 * 0.08
              b.yawRate -= Math.sign(ob) * (nx * Math.cos(b.heading) - nz * Math.sin(b.heading)) * j2 * 0.08
              if (a === this.physics || b === this.physics) playerImpact = Math.max(playerImpact, -rel)
            }
          }
        }
      }
    }
    return playerImpact
  }

  private updateDrift(dt: number, impact: number) {
    const p = this.physics
    if (impact > 3) {
      this.drift = 0
      this.driftHold = 0
      return
    }
    if (p.drifting && p.speed > 10) {
      this.drift += p.speed * Math.min(1, p.slip) * dt * 12
      this.driftHold = 1.2
    } else if (this.drift > 0) {
      this.driftHold -= dt
      if (this.driftHold <= 0) {
        this.driftBank += this.drift
        this.drift = 0
      }
    }
  }

  private updateCarVisual(r: Racer, dt: number, steer: number) {
    const p = r.physics
    const c = r.rig
    const f = this.fx.get(r)!
    c.root.position.set(p.x, 0, p.z)
    c.root.rotation.y = p.heading

    // Крен и тангаж на пружинах
    const rollT = Math.max(-0.075, Math.min(0.075, p.latAccel * 0.0065))
    const pitchT = Math.max(-0.05, Math.min(0.05, -p.longAccel * 0.0045))
    f.rollVel += ((rollT - f.roll) * 90 - f.rollVel * 11) * dt
    f.pitchVel += ((pitchT - f.pitch) * 90 - f.pitchVel * 11) * dt
    f.roll += f.rollVel * dt
    f.pitch += f.pitchVel * dt
    c.body.rotation.set(f.pitch, 0, f.roll)
    c.body.position.y = Math.sin(this.clock * 31) * 0.0025 * Math.min(1, p.speed / 30)

    for (const w of c.wheels) {
      w.spin.rotation.x = p.wheelSpin
      if (w.front) w.steer.rotation.y = p.steerAngle * 1.1 + steer * 0.02
    }
    c.uniforms.brake.value = p.braking
    c.uniforms.reverse.value = p.gear === 0 ? 1 : 0
    c.uniforms.nitro.value = p.nitroActive ? 1 : 0
    for (const fl of c.flames) {
      fl.visible = p.nitroActive
      fl.scale.set(1, 0.8 + Math.random() * 0.5, 1)
    }
    // Фонари подсвечивают только машины рядом с камерой
    if (r === this.player || c.root.position.distanceToSquared(this.camera.position) < 120 * 120) f.lamps(p.x, p.z)
  }

  private updatePlayerLights() {
    const p = this.physics
    this.uniforms.carPos.value.set(p.x, p.z)
    this.uniforms.carDir.value.set(Math.sin(p.heading), Math.cos(p.heading))
    this.uniforms.brake.value = p.braking

    // Фары следуют за машиной
    const fx = Math.sin(p.heading)
    const fz = Math.cos(p.heading)
    const lx = Math.cos(p.heading)
    const lz = -Math.sin(p.heading)
    this.headlights.forEach((l) => {
      const s = l.userData.side as number
      l.position.set(p.x + fx * 2.3 + lx * s * 0.6, 0.7, p.z + fz * 2.3 + lz * s * 0.6)
      l.target.position.set(p.x + fx * 32 + lx * s * 1.5, 0, p.z + fz * 32 + lz * s * 1.5)
      l.target.updateMatrixWorld()
    })
  }

  private tmpV = new Vector3()
  private tmpV2 = new Vector3()
  private sprayColor = new Color(0.035, 0.045, 0.06)
  private smokeColor = new Color(0.07, 0.07, 0.09)
  private sparkColor = new Color(6, 2.6, 0.8)

  private updateEffects(dt: number, impact: number, hitPoint: { x: number; z: number } | null) {
    // Брызги ботов рядом с камерой
    for (const r of this.racers) {
      if (r === this.player) continue
      const b = r.physics
      if (b.speed < 12 || Math.random() > Math.min(1, b.speed / 50) * dt * 40) continue
      if ((b.x - this.camera.position.x) ** 2 + (b.z - this.camera.position.z) ** 2 > 60 * 60) continue
      const s = Math.random() < 0.5 ? 1 : -1
      this.tmpV.set(b.x - Math.sin(b.heading) * 1.5 + Math.cos(b.heading) * s * 0.85, 0.15, b.z - Math.cos(b.heading) * 1.5 - Math.sin(b.heading) * s * 0.85)
      this.tmpV2.set(-b.vx * 0.25 + (Math.random() - 0.5) * 2, 1.2 + Math.random() * 1.8, -b.vz * 0.25 + (Math.random() - 0.5) * 2)
      this.particles.emit({ pos: this.tmpV, vel: this.tmpV2, life: 0.55, size: 0.25, grow: 1.4, color: this.sprayColor, gravity: 2, drag: 2.5 })
    }
    const p = this.physics
    const fx = Math.sin(p.heading)
    const fz = Math.cos(p.heading)
    const lx = Math.cos(p.heading)
    const lz = -Math.sin(p.heading)

    // Брызги с мокрого асфальта
    const spray = Math.min(1, p.speed / 50)
    const smoke = p.drifting && p.speed > 6 ? Math.min(1, p.slip * 1.5) : 0
    for (const s of [-1, 1]) {
      const wx = p.x - fx * 1.5 + lx * s * 0.85
      const wz = p.z - fz * 1.5 + lz * s * 0.85
      const nSpray = Math.random() < spray * dt * 60 ? 1 : 0
      for (let k = 0; k < nSpray; k++) {
        this.tmpV.set(wx, WHEEL_RADIUS * 0.4, wz)
        this.tmpV2.set(
          -p.vx * 0.25 + (Math.random() - 0.5) * 2 + lx * s * 1.5,
          1.2 + Math.random() * 1.8,
          -p.vz * 0.25 + (Math.random() - 0.5) * 2 + lz * s * 1.5,
        )
        this.particles.emit({ pos: this.tmpV, vel: this.tmpV2, life: 0.55, size: 0.25, grow: 1.4, color: this.sprayColor, gravity: 2, drag: 2.5 })
      }
      if (Math.random() < smoke * dt * 50) {
        this.tmpV.set(wx, 0.3, wz)
        this.tmpV2.set((Math.random() - 0.5) * 1.5, 0.6 + Math.random(), (Math.random() - 0.5) * 1.5)
        this.particles.emit({ pos: this.tmpV, vel: this.tmpV2, life: 1.6, size: 0.8, grow: 4.5, color: this.smokeColor, gravity: -0.4, drag: 1.2 })
      }
    }
    // Искры при ударе о стену
    if (impact > 1.5) {
      const side = Math.sign(p.lateral)
      const n = this.track.at(p.trackIndex)
      const count = Math.min(60, Math.round(impact * 5))
      for (let i = 0; i < count; i++) {
        if (hitPoint) this.tmpV.set(hitPoint.x, 0.5, hitPoint.z)
        else this.tmpV.set(p.x + n.nx * side * 0.9, 0.5, p.z + n.nz * side * 0.9)
        this.tmpV2.set(
          p.vx * 0.5 + (Math.random() - 0.5) * 6 - n.nx * side * 2,
          1 + Math.random() * 4,
          p.vz * 0.5 + (Math.random() - 0.5) * 6 - n.nz * side * 2,
        )
        this.particles.emit({ pos: this.tmpV, vel: this.tmpV2, life: 0.35 + Math.random() * 0.4, size: 0.08, grow: 0, color: this.sparkColor, gravity: 12, drag: 0.6 })
      }
    }
    this.particles.update(dt, this.camera)

    this.rain.center.value.copy(this.camera.position)
    this.rain.wind.value.set(-p.vx, 0, -p.vz)
    // Глубоко в тоннеле дождь выключаем совсем (у порталов капли гасит маска), и звук дождя затихает
    const L = this.track.length
    const sIn = ((p.trackS % L) + L) % L
    const depth = Math.min(sIn - TUNNEL.from, TUNNEL.to - sIn)
    const under = this.camera.position.y < TUNNEL.height && this.camMode !== 4 ? Math.min(1, Math.max(0, (depth - 6) / 20)) : 0
    this.rain.amount.value = 1 - under
    this.audio?.setRain(1 - Math.min(1, Math.max(0, (depth + 4) / 16)))
  }

  private updateCamera(dt: number, impact: number) {
    const p = this.physics
    const fx = Math.sin(p.heading)
    const fz = Math.cos(p.heading)
    // В заносе камера смотрит туда, куда машина едет, а не куда повёрнут кузов
    let dx = fx
    let dz = fz
    if (p.speed > 4 && p.forwardSpeed > 0) {
      const vx = p.vx / p.speed
      const vz = p.vz / p.speed
      dx = fx * 0.55 + vx * 0.45
      dz = fz * 0.55 + vz * 0.45
      const l = Math.hypot(dx, dz)
      dx /= l
      dz /= l
    }
    const speedK = Math.min(1, p.speed / 80)
    let fov = 62 + speedK * 14 + (p.nitroActive ? 8 : 0)
    const target = this.camTarget
    const look = this.camLookTarget
    let smooth = 7

    switch (this.camMode) {
      case 0:
        target.set(p.x - dx * (5.4 + speedK * 0.9), 2.45 + speedK * 0.15, p.z - dz * (5.4 + speedK * 0.9))
        look.set(p.x + dx * 3.5, 0.9, p.z + dz * 3.5)
        break
      case 1:
        // Ближняя погоня: машина крупно, камера чуть выше крыши
        target.set(p.x - dx * (3.9 + speedK * 0.5), 2.15 + speedK * 0.1, p.z - dz * (3.9 + speedK * 0.5))
        look.set(p.x + dx * 3, 0.85, p.z + dz * 3)
        smooth = 9
        fov += 2
        break
      case 2:
        target.set(p.x - dx * 11, 4.2, p.z - dz * 11)
        look.set(p.x + dx * 6, 0.8, p.z + dz * 6)
        fov -= 6
        break
      case 3:
        target.set(p.x + fx * 1.2, 0.95, p.z + fz * 1.2)
        look.set(p.x + fx * 20, 0.8, p.z + fz * 20)
        smooth = 60
        fov += 6
        break
      default: {
        // Статичные камеры у обочины, как в повторах гонок
        if (this.clock > this.tvCam.until || this.tvCam.pos.distanceTo(this.camPos) > 90) {
          const s = p.trackS + 50 + p.speed * 1.2
          const side = Math.random() < 0.5 ? 1 : -1
          const pt = this.track.sample(s, side * 7.3)
          this.tvCam.pos.set(pt.x, 1.4 + Math.random() * 3.5, pt.z)
          this.tvCam.until = this.clock + 4
          this.cut = 2
          this.camPos.copy(this.tvCam.pos)
        }
        target.copy(this.tvCam.pos)
        look.set(p.x, 0.8, p.z)
        smooth = 100
        fov = 40
      }
    }

    const k = 1 - Math.exp(-smooth * dt)
    this.camPos.lerp(target, k)
    this.camLook.lerp(look, 1 - Math.exp(-Math.max(smooth, 12) * dt))
    if (this.camMode === 4) this.camPos.copy(target)

    this.shake = Math.max(this.shake * Math.exp(-6 * dt), Math.min(1, impact * 0.08))
    // Плавная тряска (шум из синусов): случайная каждый кадр давала бы смаз на весь экран
    const shakeAmp = this.shake * 0.2 + (this.camMode < 3 ? speedK * speedK * 0.012 : 0)
    const t = this.clock
    this.camera.position.copy(this.camPos)
    this.camera.position.x += (Math.sin(t * 23.1) + Math.sin(t * 37.7) * 0.5) * shakeAmp
    this.camera.position.y += (Math.sin(t * 29.3) + Math.sin(t * 17.9) * 0.5) * shakeAmp
    this.camera.lookAt(this.camLook)
    this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-4 * dt))
    this.camera.updateProjectionMatrix()

    // После резкой смены ракурса векторы движения огромные — пару кадров без смаза
    this.blurAmount.value = this.cut > 0 ? 0 : this.camMode === 4 ? 0.04 : 0.03 + speedK * speedK * 0.1 + (p.nitroActive ? 0.06 : 0)
    if (this.cut > 0) this.cut--
  }
}

