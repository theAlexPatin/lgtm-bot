import { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';

// Verify Slack request signature
function verifySlackRequest(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string
): boolean {
  const time = Math.floor(Date.now() / 1000);

  if (Math.abs(time - parseInt(timestamp)) > 300) {
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature = `v0=${crypto
    .createHmac('sha256', signingSecret)
    .update(sigBasestring)
    .digest('hex')}`;

  return crypto.timingSafeEqual(
    Buffer.from(mySignature),
    Buffer.from(signature)
  );
}

// Parse form-urlencoded body
function parseBody(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const result: Record<string, string> = {};
  params.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const baseUrl = process.env.VERCEL_URL || process.env.BASE_URL;

  if (!signingSecret || !githubClientId || !baseUrl) {
    console.error('Missing environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const timestamp = req.headers['x-slack-request-timestamp'] as string;
  const signature = req.headers['x-slack-signature'] as string;

  // Verify request is from Slack
  if (!verifySlackRequest(rawBody, timestamp, signature, signingSecret)) {
    console.error('Invalid Slack signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const data = parseBody(rawBody);
  const userId = data.user_id;

  // Generate OAuth URL
  const state = Buffer.from(JSON.stringify({ slack_user_id: userId })).toString('base64');
  const redirectUri = `https://${baseUrl}/api/oauth/callback`;

  const githubOAuthUrl = `https://github.com/login/oauth/authorize?client_id=${githubClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=repo`;

  // Respond to Slack with instructions
  return res.status(200).json({
    response_type: 'ephemeral',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '🔗 *Connect your GitHub account*\n\nClick the button below to authorize LGTM Bot to approve PRs on your behalf.'
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Connect GitHub Account'
            },
            url: githubOAuthUrl,
            style: 'primary'
          }
        ]
      }
    ]
  });
}
