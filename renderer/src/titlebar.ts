/**
 * How much of the top bar the window's own controls have already claimed.
 *
 * On macOS the window is created with `titleBarStyle: 'hiddenInset'` (see
 * `createWindow` in electron/main.js), which removes the system title bar but
 * keeps the close/minimise/zoom buttons floating over the top-left of the web
 * contents. They are drawn by the OS, above the page, and they do not move:
 * anything the app paints underneath them is both hidden and unclickable.
 * The app name and the first navigation button used to sit exactly there.
 *
 * Windows and Linux keep their native frame, so their controls live outside
 * the web contents entirely and nothing can collide with them. That is why
 * this reserves space on one platform rather than all three, and why the app
 * does not draw its own buttons: the ones the OS draws are already in the
 * right place, in the right order, at the right size for the user's theme and
 * scaling.
 */

/**
 * Width to keep clear at the left of the top bar on macOS.
 *
 * The three buttons are 12px across on centres 20px apart, starting 20px in,
 * which ends at 66px; `hiddenInset` then shifts them further right than plain
 * `hidden` does. 78px clears them at every scale factor tested and leaves a
 * little air before the app name, rather than butting the text against the
 * zoom button.
 *
 * A constant and not `env(titlebar-area-x)`: those variables are populated
 * for the Windows title-bar overlay, and are empty under macOS's inset
 * traffic lights, so reading them here would silently reserve nothing.
 */
export const MACOS_TRAFFIC_LIGHT_INSET = 78;

/** The padding the top bar uses when nothing is overlapping it. */
export const DEFAULT_TOPBAR_INSET = 14;

/**
 * The left padding the top bar should use.
 *
 * Full screen is the case that makes this dynamic rather than a constant:
 * macOS takes the traffic lights away entirely there, and holding the space
 * open would leave the app name floating in a gap that has nothing in it.
 *
 * An unknown platform — `systemInfo` has not answered yet — is treated as not
 * macOS. Being wrong that way for one frame shifts the title 64px; being
 * wrong the other way would indent the top bar of every Windows and Linux
 * window for no reason.
 */
export function topbarInset(platform: string | undefined | null, isFullScreen: boolean): number {
  if (platform !== 'darwin' || isFullScreen) return DEFAULT_TOPBAR_INSET;
  return MACOS_TRAFFIC_LIGHT_INSET;
}
