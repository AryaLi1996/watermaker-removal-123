/**
 * Keeping the top bar clear of the window's own controls.
 *
 * The bug this covers is invisible in a screenshot taken on Linux: the macOS
 * traffic lights are drawn by the OS *above* the page, so a top bar that
 * starts at x=0 puts the app name and the first navigation button underneath
 * buttons that still receive every click. Nothing in the DOM reports the
 * collision — which is exactly why the reservation is worth pinning here.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TOPBAR_INSET,
  MACOS_TRAFFIC_LIGHT_INSET,
  topbarInset,
} from './titlebar';

describe('the top bar inset', () => {
  it('keeps the traffic lights\' corner clear on macOS', () => {
    expect(topbarInset('darwin', false)).toBe(MACOS_TRAFFIC_LIGHT_INSET);
  });

  it('reserves enough to clear all three buttons', () => {
    // 12px buttons on 20px centres from 20px in end at 66px, and `hiddenInset`
    // shifts them further right than plain `hidden`. Anything below this and
    // the app name lands on the zoom button.
    expect(MACOS_TRAFFIC_LIGHT_INSET).toBeGreaterThan(66);
  });

  it('reserves nothing on the platforms that keep a native frame', () => {
    // Windows and Linux draw their controls outside the web contents, so
    // there is nothing to avoid and an indent would just look wrong.
    for (const platform of ['win32', 'linux', 'freebsd']) {
      expect(topbarInset(platform, false), platform).toBe(DEFAULT_TOPBAR_INSET);
    }
  });

  it('closes the gap in full screen, where macOS hides the buttons', () => {
    expect(topbarInset('darwin', true)).toBe(DEFAULT_TOPBAR_INSET);
  });

  it('assumes no floating controls until the platform is known', () => {
    // `systemInfo` is null for the first frames. Indenting every window on
    // every platform for that moment is the worse of the two mistakes.
    expect(topbarInset(undefined, false)).toBe(DEFAULT_TOPBAR_INSET);
    expect(topbarInset(null, false)).toBe(DEFAULT_TOPBAR_INSET);
  });
});
