/** Short vibration pulse on successful scan (mobile / supported browsers). */
export function vibrateScanSuccess(): void {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate([35, 40, 35]);
    }
  } catch {
    /* ignore — vibration blocked without user gesture on some browsers */
  }
}
