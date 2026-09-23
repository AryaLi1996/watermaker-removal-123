/**
 * What has to be true before any part of a user's picture leaves their
 * machine, and what they have to be told first.
 *
 * The fill service runs on AWS in us-east-1. For a user in China that makes
 * every export through it a cross-border transfer of personal information,
 * which is not a detail of the deployment but the thing that decides what this
 * dialog has to say: PIPL article 39 asks for the overseas recipient by name,
 * the purpose and method, the categories of information, and how to exercise
 * rights *against that recipient* — and for consent to this specifically,
 * separately from any other agreement the user has made.
 *
 * "Separately" is the part that is easy to get wrong. A tick inside the
 * privacy policy does not count; neither does a box that arrives already
 * ticked. Hence a dialog of its own, an untitled checkbox the user has to set,
 * and a refusal that is a real choice rather than a dead end — the local
 * filler finishes the same export without any of this.
 *
 * Worth saying plainly because it is the least obvious part: the mark itself
 * is usually personal information. A Douyin watermark carries the poster's
 * account number, and that is precisely the rectangle being sent.
 */

/**
 * Who is doing the processing, and who receives it abroad.
 *
 * `processorName` is the name on the business registration, not the product's.
 * They are nearly the same word here and that is a coincidence worth not
 * relying on: what a consent notice has to name is the entity that can be
 * written to and held to this, which is the registered one.
 *
 * Changing any of these changes what the user is being told, so it goes with a
 * bump to `CONSENT_VERSION` — an agreement given to one processor is not an
 * agreement given to a different one.
 */
export const CLOUD_PARTIES = {
  /** The registered entity processing the upload. */
  processorName: '舒音 (SmootheVoice)',
  /** Where to write to exercise any of the rights below. */
  processorEmail: 'smoothevoice@outlook.com',
  /** The overseas recipient, named as PIPL art. 39 requires. */
  recipientName: 'Amazon Web Services, Inc.',
  /** Where that recipient holds and processes it. */
  recipientRegion: 'US East (N. Virginia) — us-east-1',
  /**
   * Where to write about what the overseas recipient holds.
   *
   * The same address, because that is how it actually works: AWS processes
   * this on the operator's instructions and has no relationship with the user,
   * so a request goes to the operator, who acts on it and passes on what has
   * to be passed on. Article 39 wants the user told *how* to exercise their
   * rights against the recipient, and this is how — saying so plainly beats
   * printing an address at AWS that would not answer them.
   */
  recipientContact: 'smoothevoice@outlook.com',
} as const;

/**
 * The wording the user agreed to, as a number.
 *
 * Consent is to what it said, not to the idea of it. Change what the dialog
 * claims — a different recipient, a longer retention, another purpose — and
 * this goes up, which asks everyone again. Consent that silently survives a
 * change of terms is not consent to the new ones.
 */
export const CONSENT_VERSION = 1;

export interface CloudConsent {
  /** The wording agreed to. Null where nothing has been agreed. */
  version: number | null;
  /** When, as an ISO instant, for the record they may later ask about. */
  agreedAt: string | null;
}

export const NO_CONSENT: CloudConsent = { version: null, agreedAt: null };

/**
 * Whether the notice can honestly be shown to anyone.
 *
 * Every field the dialog presents as a fact, including where the recipient
 * holds it: a row reading "held in [ to be filled in ]" is not a notice that
 * has been given, and the point of this check is that there is no version of
 * the dialog with a gap in it.
 */
export function consentIsComplete(
  parties: Record<keyof typeof CLOUD_PARTIES, string> = CLOUD_PARTIES,
): boolean {
  return Boolean(parties.processorName && parties.processorEmail
                 && parties.recipientName && parties.recipientRegion
                 && parties.recipientContact);
}

/** Whether this user has agreed to *this* wording. */
export function hasConsented(consent: CloudConsent): boolean {
  return consent.version === CONSENT_VERSION && Boolean(consent.agreedAt);
}

export function grantConsent(now: Date = new Date()): CloudConsent {
  return { version: CONSENT_VERSION, agreedAt: now.toISOString() };
}

/**
 * What the service says about this user's allowance.
 *
 * Every number in here comes from the service, including the allowance and
 * what an extra one costs. Nothing about the commercial terms is compiled into
 * the app: changing the monthly allowance, the price, or what is counted is a
 * change on the service, not a release.
 */
export interface CloudQuota {
  /** Whether this export may use the service at all. */
  allowed: boolean;
  /** Included in the plan for the current period. */
  limit: number | null;
  used: number | null;
  remaining: number | null;
  /** When the current period rolls over, as an ISO instant. */
  periodEnds: string | null;
  /** What one beyond the allowance costs, already formatted by the service. */
  overagePrice: string | null;
  /** Why not, where `allowed` is false: a key the UI has a sentence for. */
  reason: string | null;
}

/**
 * What to believe before the service has answered, and if it never does.
 *
 * Not allowed. The app cannot count what it cannot reach, and an export that
 * spends someone's money on the strength of a guess is the one outcome that
 * cannot be taken back. The local filler still finishes the job.
 */
export const QUOTA_UNKNOWN: CloudQuota = {
  allowed: false,
  limit: null,
  used: null,
  remaining: null,
  periodEnds: null,
  overagePrice: null,
  reason: 'unreachable',
};

/**
 * Whether the cloud filler would be used for an export started now.
 *
 * All four have to hold, and each says something different: the user asked for
 * it, they agreed to *this* notice, the service says their allowance covers
 * it, and the notice they agreed to actually named who receives the upload.
 * Any one of them false means the export is filled on this machine, which is
 * the outcome every one of those failures should have.
 */
export function cloudFillReady(
  enabled: boolean, consent: CloudConsent, allowed: boolean,
): boolean {
  return enabled && hasConsented(consent) && allowed && consentIsComplete();
}
