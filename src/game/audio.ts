/** Синтезированный звук: двигатель, визг шин, ветер, дождь и удары. Никаких файлов — всё в Web Audio. */
export class CarAudio {
  private ctx: AudioContext
  private master: GainNode
  private engineGain: GainNode
  private engineFilter: BiquadFilterNode
  private osc: OscillatorNode[] = []
  private screechGain: GainNode
  private screechFilter: BiquadFilterNode
  private windGain: GainNode
  private windFilter: BiquadFilterNode
  private nitroGain: GainNode
  private noise: AudioBuffer
  private muted = false
  private rainGain!: GainNode

  constructor() {
    this.ctx = new AudioContext()
    this.master = this.ctx.createGain()
    this.master.gain.value = 0.6
    const comp = this.ctx.createDynamicsCompressor()
    this.master.connect(comp).connect(this.ctx.destination)

    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate)
    const d = this.noise.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1

    /* Двигатель: три гармоники пилы и квадрата, перегруз и фильтр по нагрузке */
    this.engineFilter = this.ctx.createBiquadFilter()
    this.engineFilter.type = 'lowpass'
    this.engineFilter.Q.value = 2.5
    const shaper = this.ctx.createWaveShaper()
    const curve = new Float32Array(1024)
    for (let i = 0; i < curve.length; i++) {
      const x = (i / curve.length) * 2 - 1
      curve[i] = Math.tanh(x * 2.6)
    }
    shaper.curve = curve
    this.engineGain = this.ctx.createGain()
    this.engineGain.gain.value = 0
    const mix = this.ctx.createGain()
    mix.gain.value = 0.35
    for (const [type, gain] of [
      ['sawtooth', 0.5],
      ['square', 0.25],
      ['sawtooth', 0.3],
    ] as const) {
      const o = this.ctx.createOscillator()
      o.type = type
      const g = this.ctx.createGain()
      g.gain.value = gain
      o.connect(g).connect(mix)
      o.start()
      this.osc.push(o)
    }
    mix.connect(shaper).connect(this.engineFilter).connect(this.engineGain).connect(this.master)

    /* Визг шин */
    this.screechFilter = this.ctx.createBiquadFilter()
    this.screechFilter.type = 'bandpass'
    this.screechFilter.frequency.value = 1800
    this.screechFilter.Q.value = 6
    this.screechGain = this.ctx.createGain()
    this.screechGain.gain.value = 0
    this.loopNoise().connect(this.screechFilter).connect(this.screechGain).connect(this.master)

    /* Ветер на скорости */
    this.windFilter = this.ctx.createBiquadFilter()
    this.windFilter.type = 'lowpass'
    this.windFilter.frequency.value = 400
    this.windGain = this.ctx.createGain()
    this.windGain.gain.value = 0
    this.loopNoise().connect(this.windFilter).connect(this.windGain).connect(this.master)

    /* Дождь: постоянный мягкий шум */
    const rainF = this.ctx.createBiquadFilter()
    rainF.type = 'highpass'
    rainF.frequency.value = 2500
    const rainG = this.ctx.createGain()
    rainG.gain.value = 0.05
    this.rainGain = rainG
    this.loopNoise().connect(rainF).connect(rainG).connect(this.master)

    /* Нитро: шипение */
    const nitroF = this.ctx.createBiquadFilter()
    nitroF.type = 'bandpass'
    nitroF.frequency.value = 3200
    nitroF.Q.value = 0.8
    this.nitroGain = this.ctx.createGain()
    this.nitroGain.gain.value = 0
    this.loopNoise().connect(nitroF).connect(this.nitroGain).connect(this.master)
  }

  private loopNoise() {
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise
    src.loop = true
    src.loopStart = Math.random()
    src.start(0, Math.random() * 2)
    return src
  }

  resume() {
    return this.ctx.resume()
  }

  setMuted(m: boolean) {
    this.muted = m
    this.master.gain.setTargetAtTime(m ? 0 : 0.6, this.ctx.currentTime, 0.05)
  }

  update(s: { rpm: number; throttle: number; slip: number; speed: number; nitro: boolean; drifting: boolean }) {
    if (this.muted) return
    const t = this.ctx.currentTime
    // Четыре цилиндра: две вспышки за оборот
    const f = (s.rpm / 60) * 2
    this.osc[0].frequency.setTargetAtTime(f, t, 0.02)
    this.osc[1].frequency.setTargetAtTime(f * 0.5, t, 0.02)
    this.osc[2].frequency.setTargetAtTime(f * 2.01, t, 0.02)
    this.engineFilter.frequency.setTargetAtTime(500 + s.throttle * 2200 + s.rpm * 0.25, t, 0.05)
    this.engineGain.gain.setTargetAtTime(0.16 + s.throttle * 0.22, t, 0.05)

    const screech = s.speed > 6 ? Math.min(1, Math.max(0, (s.slip - 0.12) * 2.2)) : 0
    this.screechGain.gain.setTargetAtTime(screech * 0.22, t, 0.06)
    this.screechFilter.frequency.setTargetAtTime(1500 + screech * 900, t, 0.1)

    const wind = Math.min(1, s.speed / 80)
    this.windGain.gain.setTargetAtTime(wind * wind * 0.35, t, 0.1)
    this.windFilter.frequency.setTargetAtTime(300 + wind * 1500, t, 0.1)
    this.nitroGain.gain.setTargetAtTime(s.nitro ? 0.18 : 0, t, 0.05)
  }

  /** Громкость дождя: 1 — под открытым небом, 0 — в тоннеле */
  setRain(k: number) {
    this.rainGain.gain.setTargetAtTime(0.05 * k, this.ctx.currentTime, 0.3)
  }

  /** Сигнал стартового отсчёта */
  beep(freq: number, duration: number) {
    if (this.muted) return
    const t = this.ctx.currentTime
    const o = this.ctx.createOscillator()
    o.type = 'square'
    o.frequency.value = freq
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration)
    o.connect(g).connect(this.master)
    o.start(t)
    o.stop(t + duration + 0.05)
  }

  impact(strength: number) {
    if (this.muted || strength < 1) return
    const t = this.ctx.currentTime
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise
    const f = this.ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = 900
    const g = this.ctx.createGain()
    const v = Math.min(0.9, strength * 0.06)
    g.gain.setValueAtTime(v, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
    src.connect(f).connect(g).connect(this.master)
    src.start(t, Math.random())
    src.stop(t + 0.4)
  }

  dispose() {
    void this.ctx.close()
  }
}
