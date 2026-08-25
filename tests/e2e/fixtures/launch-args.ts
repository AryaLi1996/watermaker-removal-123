/**
 * Arguments every Electron launch in the test suite needs.
 *
 * Chromium's SUID sandbox requires chrome-sandbox to be owned by root with
 * mode 4755. A git checkout cannot carry a setuid bit, and this repo commits
 * node_modules, so Electron refuses to start on any non-root Linux machine —
 * CI included. Playwright adds this switch by itself when running as root,
 * which is why the problem only appears off a root shell.
 *
 * Test-only: the shipped app keeps its sandbox.
 */
export const SANDBOX_ARGS = process.platform === 'linux' ? ['--no-sandbox'] : [];
