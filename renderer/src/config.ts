/**
 * Build-time switches for the interface.
 *
 * Only what the *renderer* has to decide at build time belongs here. Anything
 * the main process owns — the licence endpoint, the signing secret, whether
 * manual activation is offered — is asked for over IPC instead, because a
 * value baked into the bundle cannot be changed by the process that actually
 * enforces it.
 */

/**
 * Whether to offer the demo licence — seven days of everything, once per
 * device, with no payment (see electron/demo-license.js).
 *
 * Phrased as a *disable* flag, and read that way: unset means on, so every
 * build has the entry without anyone configuring anything. A build that
 * should not carry it sets `VITE_DISABLE_DEMO_LICENSE=true` — in the build
 * environment, or in a `renderer/.env.production` that a release build
 * would pick up.
 *
 * This is only half the answer. The main process reads the same variable and
 * refuses the activation outright when it is set — a build that hid the
 * button but still answered the message would not have removed the feature.
 * The page asks for both and shows the entry only if both agree.
 */
export const ENABLE_DEMO_LICENSE = import.meta.env.VITE_DISABLE_DEMO_LICENSE !== 'true';
