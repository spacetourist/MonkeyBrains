/** Single sound hook. Wraps AE's mbaudio.js; if it fails to load/init, every call is a silent no-op. */
export type SfxName = 'tap' | 'wrong' | 'reward' | 'chimpHappy' | 'chimpSulk' | 'levelUp' | 'newBest' | 'click';
type Mb = typeof import('./mbaudio.js');
let mb: Mb | null = null;
export const audioState: { ok: boolean; diag?: unknown; error?: string } = { ok: false };
(window as any).__mbAudio = audioState;

export async function initAudio(): Promise<void> {
  try {
    const m = await import('./mbaudio.js');
    const diag: any = await m.init({ base: import.meta.env.BASE_URL + 'audio/' });
    audioState.diag = diag;
    if (diag && diag.ok === false) throw new Error(diag.error || 'init not ok');
    m.armUnlock();
    document.addEventListener('visibilitychange', () => { try { m.setPaused(document.hidden); } catch {} });
    mb = m; audioState.ok = true;
  } catch (e) {
    audioState.error = String((e as Error)?.stack || e);
    console.warn('[audio] silent:', audioState.error);
  }
}
export function sfx(name: SfxName, opts?: { index?: number }): void {
  if (!mb) return;
  try { (mb as any).sfx(name, opts); } catch (e) { audioState.error = String(e); }
}
export function ambient(on: boolean): void {
  if (!mb) return;
  try { on ? mb.ambienceStart() : mb.ambienceStop(); } catch {}
}
export function setMuted(m: boolean): void { try { mb?.setMuted(m); } catch {} }
