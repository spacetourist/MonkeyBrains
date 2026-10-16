/** Single sound hook. Wraps AE's mbaudio.js; if it fails to load/init, every call is a silent no-op. */
export type SfxName = 'tap' | 'wrong' | 'reward' | 'chimpHappy' | 'chimpSulk' | 'levelUp' | 'newBest' | 'click'
  | 'countdownTick' | 'countdownGo'; // countdown cues: no-op until AE ships the sprites
type Mb = typeof import('./mbaudio.js');
let mb: Mb | null = null;
export const audioState: { ok: boolean; diag?: unknown; error?: string } = { ok: false };
(window as any).__mbAudio = audioState;
(window as any).__mbDiag = () => { try { return (mb as any)?.diagnostics(); } catch { return null; } };

export async function initAudio(): Promise<void> {
  try {
    const m = await import('./mbaudio.js');
    const diag: any = await m.init({ base: import.meta.env.BASE_URL + 'audio/' });
    audioState.diag = diag;
    if (diag && diag.ok === false) throw new Error(diag.error || 'init not ok');
    m.armUnlock();
    document.addEventListener('visibilitychange', () => { try { m.setPaused(document.hidden); } catch {} });
    mb = m; audioState.ok = true; try { m.setMuted(wantMuted); } catch {}
  } catch (e) {
    audioState.error = String((e as Error)?.stack || e);
    console.warn('[audio] silent:', audioState.error);
  }
}
/** Gate: return true to suppress (e.g. while digits are showing). */
let gate: () => boolean = () => false;
export function setSfxGate(fn: () => boolean): void { gate = fn; }
export const sfxLog: { name: string; blocked: boolean; t: number }[] = [];
(window as any).__sfxLog = sfxLog;
export function sfx(name: SfxName, opts?: { index?: number }): void {
  const blocked = gate();
  sfxLog.push({ name, blocked, t: performance.now() }); if (sfxLog.length > 500) sfxLog.shift();
  if (blocked || !mb) return;
  try { (mb as any).sfx(name, opts); } catch (e) { audioState.error = String(e); }
}
export function ambient(on: boolean): void {
  if (!mb) return;
  try { on ? mb.ambienceStart() : mb.ambienceStop(); } catch {}
}
let wantMuted = false;
export function setMuted(m: boolean): void { wantMuted = m; try { mb?.setMuted(m); } catch {} }
