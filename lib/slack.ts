import { VercelRequest } from '@vercel/node';
import crypto from 'crypto';

// Get raw body from Vercel request
export async function getRawBody(req: VercelRequest): Promise<string> {
  if (typeof req.body === 'string') {
    return req.body;
  }

  // If body is already parsed as JSON object, convert back to JSON string
  if (req.body && typeof req.body === 'object') {
    // Check content type to determine how to reconstruct
    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('application/json')) {
      // For JSON requests, stringify the object
      // Note: This might not match the exact original formatting
      return JSON.stringify(req.body);
    } else {
      // For form-urlencoded data from Slack
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(req.body)) {
        params.append(key, String(value));
      }
      return params.toString();
    }
  }

  return '';
}

// Verify Slack request signature
export function verifySlackRequest(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string
): boolean {
  console.log('[verifySlackRequest] Verifying Slack request signature...');
  const time = Math.floor(Date.now() / 1000);
  const requestAge = Math.abs(time - parseInt(timestamp));

  console.log(`[verifySlackRequest] Request age: ${requestAge} seconds`);

  // Request is too old (replay attack prevention)
  if (requestAge > 300) {
    console.error(`[verifySlackRequest] ❌ Request timestamp too old (${requestAge}s > 300s)`);
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature = `v0=${crypto
    .createHmac('sha256', signingSecret)
    .update(sigBasestring, 'utf8')
    .digest('hex')}`;

  console.log(`[verifySlackRequest] Expected signature: ${mySignature.substring(0, 20)}...`);
  console.log(`[verifySlackRequest] Received signature: ${signature.substring(0, 20)}...`);

  try {
    const isValid = crypto.timingSafeEqual(
      Buffer.from(mySignature, 'utf8'),
      Buffer.from(signature, 'utf8')
    );

    if (isValid) {
      console.log('[verifySlackRequest] ✅ Signature verified successfully');
    } else {
      console.error('[verifySlackRequest] ❌ Signature mismatch');
    }

    return isValid;
  } catch (error) {
    console.error('[verifySlackRequest] ❌ Signature comparison failed:', error);
    return false;
  }
}

// Parse form-urlencoded body
export function parseBody(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const result: Record<string, string> = {};
  params.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
