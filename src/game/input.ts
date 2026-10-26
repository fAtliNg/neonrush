export interface Controls {
  throttle: number
  brake: number
  steer: number
  handbrake: boolean
  nitro: boolean
}

const KEYS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  nitro: ['ShiftLeft', 'ShiftRight', 'KeyN'],
}

export class Input {
  private down = new Set<string>()
  private steerSmooth = 0
  onCamera?: () => void
  onReset?: () => void

  private keydown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
    if (Object.values(KEYS).some((k) => k.includes(e.code))) e.preventDefault()
    if (e.code === 'KeyC' && !e.repeat) this.onCamera?.()
    if (e.code === 'KeyR' && !e.repeat) this.onReset?.()
    this.down.add(e.code)
  }
  private keyup = (e: KeyboardEvent) => this.down.delete(e.code)
  private blur = () => this.down.clear()

  constructor() {
    window.addEventListener('keydown', this.keydown)
    window.addEventListener('keyup', this.keyup)
    window.addEventListener('blur', this.blur)
  }

  dispose() {
    window.removeEventListener('keydown', this.keydown)
    window.removeEventListener('keyup', this.keyup)
    window.removeEventListener('blur', this.blur)
  }

  private any(codes: string[]) {
    return codes.some((c) => this.down.has(c))
  }

  read(dt: number): Controls {
    let throttle = this.any(KEYS.up) ? 1 : 0
    let brake = this.any(KEYS.down) ? 1 : 0
    let target = (this.any(KEYS.left) ? 1 : 0) - (this.any(KEYS.right) ? 1 : 0)
    let handbrake = this.any(KEYS.handbrake)
    let nitro = this.any(KEYS.nitro)

    // Геймпад: стик, курки, A — ручник, B/X — нитро
    const pad = navigator.getGamepads?.().find((p) => p && p.connected)
    let analog = false
    if (pad) {
      const ax = pad.axes[0] ?? 0
      if (Math.abs(ax) > 0.12) {
        target = -ax
        analog = true
      }
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0)
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0)
      handbrake ||= !!pad.buttons[0]?.pressed
      nitro ||= !!pad.buttons[1]?.pressed || !!pad.buttons[2]?.pressed
      if (pad.buttons[3]?.pressed && !this.padCam) this.onCamera?.()
      this.padCam = !!pad.buttons[3]?.pressed
    }

    // Клавиатура рулит плавно, как будто крутишь руль
    const rate = analog ? 20 : target === 0 ? 9 : 7
    this.steerSmooth += (target - this.steerSmooth) * Math.min(1, rate * dt)
    return { throttle, brake, steer: this.steerSmooth, handbrake, nitro }
  }

  private padCam = false
}
