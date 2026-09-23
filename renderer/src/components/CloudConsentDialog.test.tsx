/**
 * Asking before any of the user's picture leaves their machine.
 *
 * These are the properties that make the asking real rather than decorative,
 * and each of them is a way this has gone wrong in shipped software: a box
 * that arrives ticked, a refusal that is not a choice, wording that changes
 * under an agreement already given, and a notice that names nobody.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  CONSENT_VERSION, cloudFillReady, consentIsComplete, grantConsent,
  hasConsented, NO_CONSENT,
} from '../cloud';
import { setLocale } from '../i18n';

afterEach(() => {
  cleanup();
  setLocale('en');
  vi.resetModules();
});

describe('the consent record', () => {
  it('is not given until it is given', () => {
    expect(hasConsented(NO_CONSENT)).toBe(false);
  });

  it('is given once agreed, and says when', () => {
    const consent = grantConsent(new Date('2026-09-23T00:00:00Z'));
    expect(hasConsented(consent)).toBe(true);
    expect(consent.agreedAt).toBe('2026-09-23T00:00:00.000Z');
  });

  it('does not survive a change of wording', () => {
    const old = { version: CONSENT_VERSION - 1, agreedAt: '2026-01-01T00:00:00Z' };
    expect(hasConsented(old)).toBe(false);
  });

  it('is not given by a record with a time and no version', () => {
    expect(hasConsented({ version: null, agreedAt: '2026-01-01T00:00:00Z' })).toBe(false);
  });
});

describe('whether the service would be used', () => {
  const agreed = grantConsent();

  it('wants the switch, the agreement and the allowance, all three', () => {
    expect(cloudFillReady(false, agreed, true)).toBe(false);
    expect(cloudFillReady(true, NO_CONSENT, true)).toBe(false);
    expect(cloudFillReady(true, agreed, false)).toBe(false);
  });

  it('follows the notice: nothing is uploaded that cannot be described', () => {
    // Asserted against whatever this build actually carries, rather than
    // against "incomplete", so that filling CLOUD_PARTIES in one field at a
    // time does not quietly turn this into a test of nothing.
    expect(cloudFillReady(true, agreed, true)).toBe(consentIsComplete());
  });
});

describe('whether the notice can be shown at all', () => {
  const COMPLETE = {
    processorName: 'Example Ltd',
    processorEmail: 'privacy@example.com',
    recipientName: 'Amazon Web Services, Inc.',
    recipientRegion: 'US East (N. Virginia) — us-east-1',
    recipientContact: 'privacy@example.com',
  };

  it('is, once every party and address is named', () => {
    expect(consentIsComplete(COMPLETE)).toBe(true);
  });

  it('is, in the build that ships', () => {
    // The gate this guards is the one that decides whether anybody's picture
    // may leave their machine. If a field is ever emptied again — a refactor,
    // a merge, an entity that changed name — this is what says so, rather than
    // the feature silently switching itself off in front of a user.
    expect(consentIsComplete()).toBe(true);
  });

  it('is not, while any one of them is missing', () => {
    for (const field of Object.keys(COMPLETE) as (keyof typeof COMPLETE)[]) {
      expect(consentIsComplete({ ...COMPLETE, [field]: '' }))
        .toBe(false);
    }
  });
});

describe('the dialog, where the notice names nobody', () => {
  async function withoutParties() {
    vi.doMock('../cloud', async () => {
      const real = await vi.importActual<typeof import('../cloud')>('../cloud');
      return { ...real, consentIsComplete: () => false };
    });
    return (await import('./CloudConsentDialog')).default;
  }

  it('refuses to ask at all', async () => {
    const CloudConsentDialog = await withoutParties();
    render(<CloudConsentDialog onAgree={vi.fn()} onDecline={vi.fn()} />);

    expect(screen.getByTestId('cloud-consent-incomplete')).toBeTruthy();
    expect(screen.queryByTestId('cloud-consent-agree')).toBeNull();
    expect(screen.queryByTestId('cloud-consent-accept')).toBeNull();
  });

  it('lets the user out without agreeing to anything', async () => {
    const CloudConsentDialog = await withoutParties();
    const onDecline = vi.fn();
    const onAgree = vi.fn();
    render(<CloudConsentDialog onAgree={onAgree} onDecline={onDecline} />);

    fireEvent.click(screen.getByTestId('cloud-consent-decline'));
    expect(onDecline).toHaveBeenCalled();
    expect(onAgree).not.toHaveBeenCalled();
  });
});

describe('the dialog, once it can name the parties', () => {
  async function withParties() {
    vi.doMock('../cloud', async () => {
      const real = await vi.importActual<typeof import('../cloud')>('../cloud');
      return {
        ...real,
        CLOUD_PARTIES: {
          processorName: 'Example Ltd',
          processorEmail: 'privacy@example.com',
          recipientName: 'Amazon Web Services, Inc.',
          recipientRegion: 'US East (N. Virginia) — us-east-1',
          recipientContact: 'aws-privacy@example.com',
        },
        consentIsComplete: () => true,
      };
    });
    return (await import('./CloudConsentDialog')).default;
  }

  it('arrives unticked, and will not accept until it is ticked', async () => {
    const CloudConsentDialog = await withParties();
    const onAgree = vi.fn();
    render(<CloudConsentDialog onAgree={onAgree} onDecline={vi.fn()} />);

    const box = screen.getByTestId('cloud-consent-agree') as HTMLInputElement;
    const accept = screen.getByTestId('cloud-consent-accept') as HTMLButtonElement;
    expect(box.checked).toBe(false);
    expect(accept.disabled).toBe(true);

    fireEvent.click(accept);
    expect(onAgree).not.toHaveBeenCalled();

    fireEvent.click(box);
    expect(accept.disabled).toBe(false);
    fireEvent.click(accept);
    expect(onAgree).toHaveBeenCalled();
  });

  it('says what is in the rectangle before asking for it', async () => {
    const CloudConsentDialog = await withParties();
    render(<CloudConsentDialog onAgree={vi.fn()} onDecline={vi.fn()} />);
    // The mark carries the poster's account number, and that is the part
    // being sent. A notice that leaves it out is not describing the upload.
    expect(screen.getByTestId('cloud-consent-warning').textContent).toMatch(/account number/i);
  });

  it('names the overseas recipient, because the transfer leaves the country', async () => {
    const CloudConsentDialog = await withParties();
    render(<CloudConsentDialog onAgree={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByText(/Amazon Web Services/)).toBeTruthy();
    expect(screen.getByText(/us-east-1/)).toBeTruthy();
  });

  it('offers declining as a choice rather than a dead end', async () => {
    const CloudConsentDialog = await withParties();
    const onDecline = vi.fn();
    render(<CloudConsentDialog onAgree={vi.fn()} onDecline={onDecline} />);
    fireEvent.click(screen.getByTestId('cloud-consent-decline'));
    expect(onDecline).toHaveBeenCalled();
  });
});
