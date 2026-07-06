import {
  CLICKATELL_API_KEY,
  NODE_ENV,
  SMS_PROVIDER,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
} from '../config.js';

/**
 * Deliver a transactional SMS (PIN reset codes, etc.).
 * Provider is selected via SMS_PROVIDER env (console | twilio | clickatell).
 */
export async function sendSms(to: string, message: string): Promise<void> {
  const normalizedTo = to.replace(/\D/g, '');
  if (!normalizedTo) {
    throw new Error('SMS recipient phone is empty');
  }

  switch (SMS_PROVIDER) {
    case 'console': {
      if (NODE_ENV === 'production') {
        throw new Error('SMS_PROVIDER=console is not allowed in production');
      }
      console.info(`[sms:console] to=${normalizedTo} body=${message}`);
      return;
    }
    case 'twilio': {
      if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
        throw new Error(
          'Twilio SMS requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER',
        );
      }
      const body = new URLSearchParams({
        To: normalizedTo.startsWith('0') ? `+27${normalizedTo.slice(1)}` : normalizedTo,
        From: TWILIO_FROM_NUMBER,
        Body: message,
      });
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Twilio SMS failed (${res.status}): ${detail.slice(0, 200)}`);
      }
      return;
    }
    case 'clickatell': {
      if (!CLICKATELL_API_KEY) {
        throw new Error('Clickatell SMS requires CLICKATELL_API_KEY');
      }
      const res = await fetch('https://platform.clickatell.com/v1/message', {
        method: 'POST',
        headers: {
          Authorization: CLICKATELL_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              channel: 'sms',
              to: [normalizedTo.startsWith('0') ? `27${normalizedTo.slice(1)}` : normalizedTo],
              content: message,
            },
          ],
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Clickatell SMS failed (${res.status}): ${detail.slice(0, 200)}`);
      }
      return;
    }
    default:
      throw new Error(
        `Unknown SMS_PROVIDER "${SMS_PROVIDER}". Use console, twilio, or clickatell.`,
      );
  }
}
