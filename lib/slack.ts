import { VercelRequest } from '@vercel/node';
import crypto from 'crypto';

// Get raw body from Vercel request
export async function getRawBody(req: VercelRequest): Promise<string> {
  // If body is already a string, return it
  if (typeof req.body === 'string') {
    return req.body;
  }

  // Read from the request stream if body parsing is disabled
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk.toString();
    });
    req.on('end', () => {
      resolve(data);
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
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
