/* Safari до 16.4 знает только webkit-версии API */
type Doc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> }
type El = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }

export function isFullscreen() {
  const d = document as Doc
  return !!(d.fullscreenElement ?? d.webkitFullscreenElement)
}

export function fullscreenSupported() {
  const el = document.documentElement as El
  return !!(el.requestFullscreen ?? el.webkitRequestFullscreen)
}

export async function toggleFullscreen() {
  const d = document as Doc
  const el = document.documentElement as El
  try {
    if (isFullscreen()) await (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.())
    else await (el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.())
  } catch {
    /* браузер отказал, например без жеста пользователя */
  }
}

export function onFullscreenChange(cb: () => void) {
  document.addEventListener('fullscreenchange', cb)
  document.addEventListener('webkitfullscreenchange', cb)
  return () => {
    document.removeEventListener('fullscreenchange', cb)
    document.removeEventListener('webkitfullscreenchange', cb)
  }
}
