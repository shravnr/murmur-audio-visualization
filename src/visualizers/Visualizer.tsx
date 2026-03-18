import { useRef, useEffect } from "react"

export interface VisualizerProps {
  frequencyData: React.RefObject<Uint8Array<ArrayBuffer>>
  timeDomainData: React.RefObject<Uint8Array<ArrayBuffer>>
  isActive: boolean
  width: number
  height: number
}

// ─── 2D Value Noise (module-level, initialized once) ───────────────────────

const _perm = new Uint8Array(512)
;(() => {
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[p[i], p[j]] = [p[j], p[i]]
  }
  for (let i = 0; i < 512; i++) _perm[i] = p[i & 255]
})()

const _gradX = new Float32Array(256)
const _gradY = new Float32Array(256)
;(() => {
  for (let i = 0; i < 256; i++) {
    const a = (i / 256) * Math.PI * 2
    _gradX[i] = Math.cos(a)
    _gradY[i] = Math.sin(a)
  }
})()

function _fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function _lerp(a: number, b: number, t: number): number {
  return a + t * (b - a)
}

function noise2d(x: number, y: number): number {
  const xi = Math.floor(x) & 255
  const yi = Math.floor(y) & 255
  const xf = x - Math.floor(x)
  const yf = y - Math.floor(y)
  const u = _fade(xf)
  const v = _fade(yf)
  const aa = _perm[_perm[xi] + yi]
  const ab = _perm[_perm[xi] + yi + 1]
  const ba = _perm[_perm[xi + 1] + yi]
  const bb = _perm[_perm[xi + 1] + yi + 1]
  const g = (idx: number, dx: number, dy: number) =>
    _gradX[idx] * dx + _gradY[idx] * dy
  return _lerp(
    _lerp(g(aa, xf, yf), g(ba, xf - 1, yf), u),
    _lerp(g(ab, xf, yf - 1), g(bb, xf - 1, yf - 1), u),
    v,
  )
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface PappusHair {
  angle: number
  len: number
  cpFraction: number // control point fraction along hair for quadratic curve
}

interface DandelionSeed {
  angle: number
  length: number
  depthFactor: number // cos(angle) — front seeds > 0
  pappusRadius: number
  hairs: PappusHair[]
  isDetached: boolean
  detachProgress: number // 0 = attached, 1 = fully removed
  reattachAt: number // frame number when this seed regenerates
}

interface FlyingSeed {
  x: number // pappus tip position
  y: number
  vx: number
  vy: number
  age: number
  maxAge: number
  pappusRadius: number
  stalkLength: number // stalk extends backward from pappus tip along displayAngle
  hairs: PappusHair[] // same hair data as attached seed
  displayAngle: number // orientation: pappus faces this direction, stalk trails behind
  trail: Array<[number, number]>
  spiralPhase: number
  opacity: number
  launchTone: number // tone at spawn: drives per-seed vertical physics (treble=up, bass=down)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function rng(): number {
  return Math.random()
}

function buildDandelionSeeds(count: number): DandelionSeed[] {
  const seeds: DandelionSeed[] = []
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const t = i / count
    // Sunflower spiral angle with slight jitter
    const angle = i * goldenAngle + (rng() - 0.5) * 0.12
    // Length: peaks at t≈0.45, shorter near center & edges — gives natural density
    const lengthBase = 44 + Math.sin(t * Math.PI) * 54
    const length = lengthBase + (rng() - 0.5) * 10
    // Depth: seeds near angle=0 (right) face viewer, angle=π face away
    // We use 2D angle so depth is cos of the angle modulo 2π
    const depthFactor = Math.cos(angle)
    const pappusRadius = 10 + depthFactor * 5 + rng() * 3.5

    const numHairs = 12 + Math.floor(rng() * 4)
    const hairs: PappusHair[] = []
    for (let h = 0; h < numHairs; h++) {
      hairs.push({
        angle: (h / numHairs) * Math.PI * 2 + (rng() - 0.5) * 0.4,
        len: pappusRadius * (0.55 + rng() * 0.5),
        cpFraction: 0.4 + rng() * 0.3,
      })
    }
    seeds.push({
      angle,
      length,
      depthFactor,
      pappusRadius,
      hairs,
      isDetached: false,
      detachProgress: 0,
      reattachAt: 0,
    })
  }
  return seeds
}

// ─── Drawing primitives ─────────────────────────────────────────────────────

function drawOneSeed(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  seed: DandelionSeed,
  opacity: number,
  lean: number = 0,
  growthFrac: number = 1,  // 0 = just started growing, 1 = full length
): void {
  if (opacity <= 0.01 || growthFrac <= 0.01) return
  const angle = seed.angle + lean
  // Filament grows outward from center — tip advances as growthFrac increases
  const currentLength = seed.length * growthFrac
  const tipX = cx + Math.cos(angle) * currentLength
  const tipY = cy + Math.sin(angle) * currentLength

  // Stalk — always fully opaque, just shorter while growing
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(tipX, tipY)
  ctx.strokeStyle = `rgba(245,240,228,${opacity * 0.75})`
  ctx.lineWidth = 0.45
  ctx.stroke()

  // Pappus hairs — appear only in the final 25% of growth, fading in naturally
  const pappusOp = growthFrac < 0.75 ? 0 : (growthFrac - 0.75) / 0.25
  if (pappusOp > 0.01) {
    const NUM_HAIRS = 35
    const HAIR_LEN = 6.5
    const CP_FRAC = 0.55
    ctx.lineWidth = 1.5
    ctx.strokeStyle = `rgba(245,240,228,${opacity * 0.52 * pappusOp})`
    for (let i = 0; i < NUM_HAIRS; i++) {
      const a = (i / NUM_HAIRS) * Math.PI * 2
      const ex = tipX + Math.cos(a) * HAIR_LEN
      const ey = tipY + Math.sin(a) * HAIR_LEN
      const cpx = tipX + Math.cos(a) * HAIR_LEN * CP_FRAC
      const cpy = tipY + Math.sin(a) * HAIR_LEN * CP_FRAC
      ctx.beginPath()
      ctx.moveTo(tipX, tipY)
      ctx.quadraticCurveTo(cpx, cpy, ex, ey)
      ctx.stroke()
    }
    // Bright tip dot — appears with pappus
    ctx.beginPath()
    ctx.arc(tipX, tipY, 1.1, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255,250,240,${opacity * 0.92 * pappusOp})`
    ctx.fill()
  }
}

// Draw a flying seed: stalk trails behind the pappus tuft, identical visual to attached seeds
function drawFlyingSeedFull(
  ctx: CanvasRenderingContext2D,
  fs: FlyingSeed,
  opacityOverride?: number,
): void {
  const opacity = opacityOverride ?? fs.opacity
  if (opacity <= 0.01) return
  const { x, y } = fs

  // Tone-based color: bass (launchTone=0) → cool silver-white, treble (launchTone=1) → warm amber
  const tr = fs.launchTone
  const cr = Math.round(210 + tr * 45) // 210 → 255
  const cg = Math.round(225 - tr * 15) // 225 → 210
  const cb = Math.round(245 - tr * 115) // 245 → 130

  // Streaming pappus — hairs blend toward "behind the direction of travel" based on speed.
  // At rest: symmetric snowflake. Moving: hairs sweep backward like a tiny comet of feathers.
  const { vx, vy } = fs
  const NUM_HAIRS = 35
  const HAIR_LEN = 6.5
  const speed = Math.sqrt(vx * vx + vy * vy)
  const streamStr = Math.min(speed * 0.1, 0.22) // 80% open, 20% lean — barely suggests direction
  const streamDir = Math.atan2(-vy, -vx) // "behind" = opposite of velocity
  const cosDest = Math.cos(streamDir)
  const sinDest = Math.sin(streamDir)
  ctx.lineWidth = 1.5
  ctx.strokeStyle = `rgba(${cr},${cg},${cb},${opacity * 0.52})`
  for (let i = 0; i < NUM_HAIRS; i++) {
    const baseA = (i / NUM_HAIRS) * Math.PI * 2
    // Blend base angle toward stream direction on the unit circle
    const cosA = Math.cos(baseA) * (1 - streamStr) + cosDest * streamStr
    const sinA = Math.sin(baseA) * (1 - streamStr) + sinDest * streamStr
    const a = Math.atan2(sinA, cosA)
    // Hairs lengthen as speed increases — trailing feathers stretch out
    const len = HAIR_LEN * (1 + streamStr * 0.7)
    // More pronounced curve when streaming (feathers billow in the wake)
    const cp = 0.55 + streamStr * 0.22
    const ex = x + Math.cos(a) * len
    const ey = y + Math.sin(a) * len
    const cpx = x + Math.cos(a) * len * cp
    const cpy = y + Math.sin(a) * len * cp
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.quadraticCurveTo(cpx, cpy, ex, ey)
    ctx.stroke()
  }

  // Bright center dot
  ctx.beginPath()
  ctx.arc(x, y, 1.1, 0, Math.PI * 2)
  ctx.fillStyle = `rgba(${Math.min(255, cr + 20)},${Math.min(255, cg + 20)},${Math.min(255, cb + 20)},${opacity * 0.92})`
  ctx.fill()
}

// ─── Visualizer component ───────────────────────────────────────────────────

export function Visualizer({
  frequencyData,
  timeDomainData,
  isActive,
  width,
  height,
}: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // All mutable state lives in refs — no re-renders
  const frameRef = useRef(0)
  const dandelionSeedsRef = useRef<DandelionSeed[]>([])
  const flyingSeedsRef = useRef<FlyingSeed[]>([])
  const windOffsetRef = useRef(0)
  const prevIntensityRef = useRef(0)
  const noiseTextureRef = useRef<HTMLCanvasElement | null>(null)
  const animRef = useRef<number>(0)
  const ruffleIntensityRef = useRef(0) // smoothed voice intensity driving the ruffle
  const rufflePhaseRef = useRef(0) // advances to create ripple propagation across seeds
  const lastReattachFrameRef = useRef(0) // rate-limits seed regeneration to one per ~1.5 s
  const micRevealRef = useRef(0)         // 0 = mic not yet granted, 1 = fully revealed
  const dandelionRevealRef = useRef(0)   // 0 = hidden, 1 = fully faded in
  const depletionGlowRef = useRef(0) // 0 = normal, 1 = full ember glow
  const depletionBreathRef = useRef(0) // phase for slow breathing pulse

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // Retina / HiDPI: scale canvas by devicePixelRatio so sub-pixel filaments render crisply
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    ctx.scale(dpr, dpr)

    // Build dandelion seeds once
    dandelionSeedsRef.current = buildDandelionSeeds(500)

    // Pre-generate grain texture (small, tiled)
    const grain = document.createElement("canvas")
    grain.width = 200
    grain.height = 200
    const gctx = grain.getContext("2d")!
    const imgData = gctx.createImageData(200, 200)
    for (let i = 0; i < imgData.data.length; i += 4) {
      const v = Math.random() * 255
      imgData.data[i] = v
      imgData.data[i + 1] = v
      imgData.data[i + 2] = v
      imgData.data[i + 3] = Math.random() * 18 // very faint
    }
    gctx.putImageData(imgData, 0, 0)
    noiseTextureRef.current = grain

    const draw = () => {
      const frame = ++frameRef.current
      const W = width
      const H = height

      // ── Audio signals ──────────────────────────────────────────────────
      const td = timeDomainData.current
      const fd = frequencyData.current

      // Guard: real mic data centers near 128; an all-zero buffer means the
      // analyser hasn't filled it yet. Zeros masquerade as max amplitude
      // because (0 - 128)² = 16384 — the highest possible deviation.
      const bufferReady =
        isActive &&
        td.length > 0 &&
        (td[0] | td[td.length >> 1] | td[td.length - 1]) > 0

      let sumSq = 0
      if (bufferReady) {
        for (let i = 0; i < td.length; i++) sumSq += (td[i] - 128) ** 2
      }
      const rms = bufferReady ? Math.sqrt(sumSq / td.length) : 0
      const intensity = bufferReady ? clamp(rms / 30, 0, 1) : 0

      let wNum = 0,
        wDen = 0
      if (bufferReady) {
        for (let i = 0; i < fd.length; i++) {
          wNum += fd[i] * i
          wDen += fd[i]
        }
      }
      const tone =
        bufferReady && wDen > 0.001 ? clamp(wNum / wDen / fd.length, 0, 1) : 0.3
      const rhythm = clamp(
        Math.abs(intensity - prevIntensityRef.current) * 7,
        0,
        1,
      )
      prevIntensityRef.current = intensity

      windOffsetRef.current += 0.00065 + intensity * 0.0018

      // ── Ruffle (voice disturbance on seed head) ────────────────────────
      // Fast attack, slow decay — so ruffle lingers briefly after voice stops
      const ri = ruffleIntensityRef.current
      ruffleIntensityRef.current =
        ri +
        (intensity > ri
          ? (intensity - ri) * 0.22 // attack: fast, voice lands quickly
          : (intensity - ri) * 0.04) // decay: slow, ruffle fades organically
      rufflePhaseRef.current += 0.28 + ruffleIntensityRef.current * 1.4
      const ruffle = ruffleIntensityRef.current
      const rufflePhase = rufflePhaseRef.current

      // ── Head position — fixed, stem and head center never translate ──────
      const t = frame
      const headX = 195
      const headY = 205

      // ── Background ─────────────────────────────────────────────────────
      const bgGrad = ctx.createLinearGradient(0, 0, 0, H)
      bgGrad.addColorStop(0, "#0a1a0d")
      bgGrad.addColorStop(0.45, "#162b18")
      bgGrad.addColorStop(1, "#0a1a0d")
      ctx.fillStyle = bgGrad
      ctx.fillRect(0, 0, W, H)

      // Warm amber glow behind dandelion — follows head position
      const glow = ctx.createRadialGradient(
        headX - 10,
        headY - 15,
        0,
        headX - 10,
        headY - 15,
        235,
      )
      glow.addColorStop(0, "rgba(162,122,32,0.22)")
      glow.addColorStop(0.38, "rgba(110,82,18,0.14)")
      glow.addColorStop(1, "rgba(0,0,0,0)")
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, W, H)

      // Smaller bright highlight
      const hi = ctx.createRadialGradient(
        headX + 8,
        headY - 20,
        0,
        headX + 8,
        headY - 20,
        95,
      )
      hi.addColorStop(0, "rgba(210,175,70,0.10)")
      hi.addColorStop(1, "rgba(0,0,0,0)")
      ctx.fillStyle = hi
      ctx.fillRect(0, 0, W, H)

      // Vignette
      const vig = ctx.createRadialGradient(
        W * 0.5,
        H * 0.5,
        H * 0.28,
        W * 0.5,
        H * 0.5,
        H * 0.88,
      )
      vig.addColorStop(0, "rgba(0,0,0,0)")
      vig.addColorStop(1, "rgba(0,0,0,0.48)")
      ctx.fillStyle = vig
      ctx.fillRect(0, 0, W, H)

      // Grain texture (tiled)
      if (noiseTextureRef.current) {
        ctx.globalAlpha = 0.045
        const g = noiseTextureRef.current
        for (let gx = 0; gx < W; gx += 200)
          for (let gy = 0; gy < H; gy += 200) ctx.drawImage(g, gx, gy)
        ctx.globalAlpha = 1
      }

      // ── Mic permission reveal ───────────────────────────────────────────
      micRevealRef.current = isActive
        ? Math.min(micRevealRef.current + 0.010, 1)   // fade in over ~1.7 s
        : Math.max(micRevealRef.current - 0.006, 0)   // fade back if revoked
      const micReveal = micRevealRef.current

      if (micReveal < 1) {
        // "awaiting" text — fades out as mic activates
        const textOp = 1 - micReveal
        ctx.save()
        ctx.globalAlpha = textOp
        ctx.font = 'italic 14px Georgia, "Times New Roman", serif'
        ctx.fillStyle = 'rgba(240, 228, 210, 1)'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('awaiting microphone input…', W / 2, H / 2)
        ctx.restore()
      }

      if (micReveal < 1) {
        dandelionRevealRef.current = 0   // reset so next reveal always fades in fresh
        animRef.current = requestAnimationFrame(draw)
        return
      }

      // Dandelion fades in after text is fully gone
      dandelionRevealRef.current = Math.min(dandelionRevealRef.current + 0.014, 1)
      const dandelionReveal = dandelionRevealRef.current

      // ── Stem — completely still, rooted, never moves ───────────────────
      ctx.beginPath()
      ctx.moveTo(195, 205)
      ctx.bezierCurveTo(200, 280, 210, 355, 213, H - 28)
      ctx.strokeStyle = "rgba(70,102,44,0.88)"
      ctx.lineWidth = 2.6
      ctx.stroke()

      // ── Update dandelion seed detach / reattach ─────────────────────────
      const seeds = dandelionSeedsRef.current
      // Advance detach / reattach animations
      for (const s of seeds) {
        if (s.isDetached && s.detachProgress < 1) {
          s.detachProgress = Math.min(s.detachProgress + 0.06, 1) // fast fade-out
        } else if (!s.isDetached && s.detachProgress > 0) {
          s.detachProgress = Math.max(s.detachProgress - 0.025, 0) // growth animation (~40 frames ≈ 0.65 s)
        }
      }

      // ── Depletion glow — center ember when all seeds are gone ───────────
      const attachedCount = seeds.filter((s) => !s.isDetached).length
      const fullyDepleted = attachedCount === 0
      const dg = depletionGlowRef.current
      depletionGlowRef.current =
        fullyDepleted && intensity > 0.034
          ? dg + (1 - dg) * 0.015 // attack: ~2.5 s to saturate at loud speech
          : dg * 0.992 // decay: ~9 s half-life — lingers like a cooling ember
      const depletionGlow = depletionGlowRef.current
      depletionBreathRef.current += 0.022 + depletionGlow * 0.012
      const breathPulse = (Math.sin(depletionBreathRef.current) + 1) / 2 // 0–1

      // Spawn flying seeds — lower threshold so a whisper releases 1–2 seeds,
      // normal speech gives a steady stream, loud voice bursts
      const spawnFloat = intensity < 0.034 ? 0 : (intensity - 0.020) ** 1.65 * 4
      const spawnCount =
        Math.floor(spawnFloat) + (rng() < spawnFloat % 1 ? 1 : 0)
      for (let n = 0; n < spawnCount; n++) {
        if (flyingSeedsRef.current.length >= 200) break
        const candidates = seeds.filter((s) => !s.isDetached)
        if (candidates.length === 0) break
        const src = candidates[Math.floor(rng() * candidates.length)]
        src.isDetached = true
        src.detachProgress = 0
        src.reattachAt = frame + 8 // tiny delay so detach animates before returning

        const tipX = headX + Math.cos(src.angle) * src.length
        const tipY = headY + Math.sin(src.angle) * src.length

        // Base angle: bass=gentle/rightward, treble=steeper upward
        const toneAngle = -(0.28 + tone * 0.38)
        // Wide uniform spread so seeds fill the whole right half, not just one diagonal lane
        const halfSpread = 0.55 + intensity * 0.65 + rhythm * 0.3
        const fan = (rng() - 0.5) * 2 * halfSpread
        const launchAngle = toneAngle + fan
        const speed = 0.2 + intensity * 0.9 + rng() * 0.25 + rhythm * 0.1
        flyingSeedsRef.current.push({
          x: tipX,
          y: tipY,
          vx: Math.cos(launchAngle) * speed,
          // Natural launch — wide fan means some seeds go lower-right, others upper-right
          // Per-seed physics drift determines final trajectory; don't force everything upward
          vy: Math.sin(launchAngle) * speed,
          age: 0,
          maxAge: 120 + Math.floor(intensity * 220 + rng() * 100),
          pappusRadius: src.pappusRadius,
          stalkLength: src.length, // match attached seed's actual filament length
          hairs: src.hairs,
          displayAngle: src.angle,
          trail: [],
          spiralPhase: rng() * Math.PI * 2,
          opacity: 1,
          launchTone: tone,
        })
      }

      // Reattach seeds — one at a time, only during silence, ~0.25 s between each seed
      // This makes recovery feel gradual and meaningful rather than an instant reset
      if (intensity < 0.034 && frame - lastReattachFrameRef.current >= 5) {
        const eligible = seeds.filter(
          (s) => s.isDetached && frame >= s.reattachAt,
        )
        if (eligible.length > 0) {
          const pick = eligible[Math.floor(rng() * eligible.length)]
          pick.isDetached = false
          pick.detachProgress = 1 // start invisible — fade in via animation loop
          lastReattachFrameRef.current = frame
        }
      }

      // ── Draw dandelion seeds (3 depth passes) ──────────────────────────
      // Per-seed angle offset: idle breathing wave (always present, each seed oscillates
      // at a different phase for organic feel) + voice ruffle (travelling wave on voice)
      const seedOffset = (s: DandelionSeed) =>
        Math.sin(t * 0.022 + s.angle * 1.8) * 0.07 + // idle: visible gentle sway
        ruffle * Math.sin(rufflePhase + s.angle * 2.5) * (0.12 + ruffle * 0.34) // voice: ruffle wave

      ctx.save()
      for (const s of seeds) {
        if (s.depthFactor >= -0.3) continue
        // Detaching: fade out at full length. Regenerating: full opacity, growing length.
        const op     = s.isDetached ? (1 - s.detachProgress) * 0.42 : 0.42
        const growth = s.isDetached ? 1 : (1 - s.detachProgress)
        drawOneSeed(ctx, headX, headY, s, op, seedOffset(s), growth)
      }
      for (const s of seeds) {
        if (s.depthFactor < -0.3 || s.depthFactor >= 0.3) continue
        const op     = s.isDetached ? (1 - s.detachProgress) * 0.68 : 0.68
        const growth = s.isDetached ? 1 : (1 - s.detachProgress)
        drawOneSeed(ctx, headX, headY, s, op, seedOffset(s), growth)
      }
      for (const s of seeds) {
        if (s.depthFactor < 0.3) continue
        const op     = s.isDetached ? (1 - s.detachProgress) * 0.94 : 0.94
        const growth = s.isDetached ? 1 : (1 - s.detachProgress)
        drawOneSeed(ctx, headX, headY, s, op, seedOffset(s), growth)
      }
      ctx.restore()

      // ── Center orb — expands into a warm ember when fully depleted ────────
      const glowRadius = 18 + depletionGlow * 52
      const glowPeakOp =
        (0.28 + depletionGlow * 0.52) * (0.8 + breathPulse * 0.2)
      const orbGlow = ctx.createRadialGradient(
        headX,
        headY,
        0,
        headX,
        headY,
        glowRadius,
      )
      orbGlow.addColorStop(0, `rgba(220,185,110,${glowPeakOp})`)
      orbGlow.addColorStop(0.35, `rgba(200,120, 40,${glowPeakOp * 0.5})`)
      orbGlow.addColorStop(1, "rgba(0,0,0,0)")
      ctx.fillStyle = orbGlow
      ctx.beginPath()
      ctx.arc(headX, headY, glowRadius, 0, Math.PI * 2)
      ctx.fill()

      // Ember ring — amber-orange halo, only when depleted
      if (depletionGlow > 0.05) {
        const ringOp = depletionGlow * 0.4 * (0.6 + breathPulse * 0.4)
        const ringOuter = glowRadius * 0.55
        const ring = ctx.createRadialGradient(
          headX,
          headY,
          7,
          headX,
          headY,
          ringOuter,
        )
        ring.addColorStop(0, `rgba(255,160,40,${ringOp})`)
        ring.addColorStop(0.5, `rgba(200,100,20,${ringOp * 0.45})`)
        ring.addColorStop(1, "rgba(0,0,0,0)")
        ctx.fillStyle = ring
        ctx.beginPath()
        ctx.arc(headX, headY, ringOuter, 0, Math.PI * 2)
        ctx.fill()
      }

      // Solid orb — pulses gently, color shifts cream-gold → deep ember orange
      const orbRadius = 7.5 + depletionGlow * 3.0 * (0.85 + breathPulse * 0.15)
      const r0 = Math.round(232 + depletionGlow * 23) // 232 → 255
      const g0 = Math.round(212 - depletionGlow * 52) // 212 → 160
      const b0 = Math.round(160 - depletionGlow * 80) // 160 → 80
      const r1 = Math.round(176 + depletionGlow * 54) // 176 → 230
      const g1 = Math.round(144 - depletionGlow * 94) // 144 → 50
      const b1 = Math.round(80 - depletionGlow * 48) // 80  → 32
      ctx.beginPath()
      ctx.arc(headX, headY, orbRadius, 0, Math.PI * 2)
      const orbFill = ctx.createRadialGradient(
        headX - 2,
        headY - 2,
        0,
        headX,
        headY,
        orbRadius,
      )
      orbFill.addColorStop(0, `rgb(${r0},${g0},${b0})`)
      orbFill.addColorStop(1, `rgb(${r1},${g1},${b1})`)
      ctx.fillStyle = orbFill
      ctx.fill()

      // ── Flying seeds: update & draw ────────────────────────────────────
      const windOff = windOffsetRef.current
      const living: FlyingSeed[] = []

      for (const fs of flyingSeedsRef.current) {
        fs.age++
        if (fs.age > fs.maxAge || fs.x > W + 60 || fs.y < -60 || fs.y > H + 60)
          continue

        // Trail — 8 faint ghost dots for motion blur
        fs.trail.unshift([fs.x, fs.y])
        if (fs.trail.length > 8) fs.trail.pop()

        const wx = noise2d(fs.x * 0.006, fs.y * 0.006 + windOff)
        const wy = noise2d(fs.x * 0.006 + 200, fs.y * 0.006 + windOff) // large offset → independent axes

        // Per-seed drift derived from spiralPhase — each seed wanders its own path
        const seedDriftX =
          0.025 + Math.abs(Math.cos(fs.spiralPhase * 1.7)) * 0.04 // 0.025–0.065 — gentle rightward drift
        const seedDriftY = Math.sin(fs.spiralPhase * 2.3) * 0.05 // ±0.050 — soft vertical spread

        // Very gentle upward bias — seeds float, not fly
        const windUp = intensity > 0.034 ? -(0.01 + intensity * 0.012) : 0.008

        fs.vx +=
          wx * 0.045 +
          seedDriftX +
          Math.sin(fs.age * 0.18 + fs.spiralPhase) * 0.015
        fs.vy +=
          wy * 0.04 +
          windUp +
          seedDriftY +
          Math.cos(fs.age * 0.13 + fs.spiralPhase) * 0.012

        fs.vx *= 0.974
        fs.vy *= 0.974

        fs.x += fs.vx
        fs.y += fs.vy

        // displayAngle slowly tracks travel direction so pappus leads, stalk trails
        const travelAngle = Math.atan2(fs.vy, fs.vx)
        let da = travelAngle - fs.displayAngle
        // Normalize to [-π, π]
        da = da - Math.PI * 2 * Math.round(da / (Math.PI * 2))
        fs.displayAngle += da * 0.06

        // Opacity fade (ease-out)
        const lifeT = fs.age / fs.maxAge
        fs.opacity = clamp(
          (1 - lifeT ** 1.3) * (lifeT < 0.06 ? lifeT / 0.06 : 1),
          0,
          1,
        )

        // Draw faint trail dots (pappus tip only)
        const tLen = fs.trail.length
        for (let ti = tLen - 1; ti >= 0; ti--) {
          const trailAlpha = ((tLen - ti) / tLen) * fs.opacity * 0.22
          const [tx, ty] = fs.trail[ti]
          ctx.beginPath()
          ctx.arc(tx, ty, 0.7, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(255,250,240,${trailAlpha})`
          ctx.fill()
        }
        // Draw full filament seed
        drawFlyingSeedFull(ctx, fs)

        living.push(fs)
      }

      flyingSeedsRef.current = living

      // Soft fade-in: overlay background gradient at decreasing opacity
      if (dandelionReveal < 1) {
        const fadeGrad = ctx.createLinearGradient(0, 0, 0, H)
        fadeGrad.addColorStop(0, '#0a1a0d')
        fadeGrad.addColorStop(0.45, '#162b18')
        fadeGrad.addColorStop(1, '#0a1a0d')
        ctx.save()
        ctx.globalAlpha = 1 - dandelionReveal
        ctx.fillStyle = fadeGrad
        ctx.fillRect(0, 0, W, H)
        ctx.restore()
      }

      animRef.current = requestAnimationFrame(draw)
    }

    animRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animRef.current)
  }, [isActive, frequencyData, timeDomainData, width, height])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ display: "block" }}
    />
  )
}
