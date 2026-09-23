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

  it('refuses while the notice cannot name who receives the upload', () => {
    // The contact details are blank in this build on purpose — see
    // CLOUD_PARTIES. Until they are filled in, nothing may be uploaded, and
    // this is the check that makes that true rather than aspirational.
    expect(consentIsComplete()).toBe(false);
    expect(cloudFillReady(true, agreed, true)).toBe(false);
  });
});

describe('the dialog', () => {
  it('refuses to ask at all while the notice names nobody', async () => {
    const { default: CloudConsentDialog } = await import('./CloudConsentDialog');
    render(<CloudConsentDialog onAgree={vi.fn()} onDecline={vi.fn()} />);

    expect(screen.getByTestId('cloud-consent-incomplete')).toBeTruthy();
    expect(screen.queryByTestId('cloud-consent-agree')).toBeNull();
    expect(screen.queryByTestId('cloud-consent-accept')).toBeNull();
  });

  it('lets the user out of an incomplete notice without agreeing', async () => {
    const { default: CloudConsentDialog } = await import('./CloudConsentDialog');
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
