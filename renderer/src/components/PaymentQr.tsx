/**
 * A stand-in for the QR code a payment provider would return.
 *
 * Drawn rather than shipped as an image: it costs no asset, scales cleanly,
 * and differs per order, so the dialog looks like what it will eventually be.
 * It encodes nothing — scanning it does nothing at all, which is why the
 * dialog says in words that this is a simulation.
 */
interface PaymentQrProps {
  /** Anything that identifies the order; the pattern is derived from it. */
  seed: string;
  /** Brand colour of the chosen payment method. */
  color: string;
  size?: number;
}

const MODULES = 21;

/** A cheap deterministic hash: the same seed always draws the same code. */
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The three orientation squares a real code carries, one per corner. */
function isFinder(x: number, y: number): boolean {
  const inBox = (ox: number, oy: number) =>
    x >= ox && x < ox + 7 && y >= oy && y < oy + 7;
  return inBox(0, 0) || inBox(MODULES - 7, 0) || inBox(0, MODULES - 7);
}

export default function PaymentQr({ seed, color, size = 148 }: PaymentQrProps) {
  const base = hash(seed);
  const cells: { x: number; y: number }[] = [];

  for (let y = 0; y < MODULES; y++) {
    for (let x = 0; x < MODULES; x++) {
      if (isFinder(x, y)) {
        // Ring plus centre — the shape every code has.
        const ox = x >= MODULES - 7 ? x - (MODULES - 7) : x;
        const oy = y >= MODULES - 7 ? y - (MODULES - 7) : y;
        const edge = ox === 0 || ox === 6 || oy === 0 || oy === 6;
        const core = ox >= 2 && ox <= 4 && oy >= 2 && oy <= 4;
        if (edge || core) cells.push({ x, y });
        continue;
      }
      if (((base >>> ((x * 7 + y * 13) % 31)) ^ (x * 31 + y * 17)) % 3 === 0) {
        cells.push({ x, y });
      }
    }
  }

  return (
    <svg
      data-testid="payment-qr"
      width={size}
      height={size}
      viewBox={`0 0 ${MODULES} ${MODULES}`}
      role="img"
      aria-hidden="true"
      // White whatever the theme: a payment code is read by a camera, and
      // the quiet zone around it is part of the format, not decoration.
      style={{ background: '#ffffff', borderRadius: 6, padding: 4, boxSizing: 'content-box' }}
    >
      {cells.map(({ x, y }) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={color} />
      ))}
    </svg>
  );
}
