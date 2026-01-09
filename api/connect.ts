import { VercelRequest, VercelResponse } from '@vercel/node';
import { getRawBody, verifySlackRequest, parseBody } from '../lib/slack';

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

  const rawBody = await getRawBody(req);
  const timestamp = req.headers['x-slack-request-timestamp'] as string;
  const signature = req.headers['x-slack-signature'] as string;

  if (!timestamp || !signature) {
    console.error('Missing Slack headers');
    return res.status(401).json({ error: 'Missing Slack headers' });
  }

  // Verify request is from Slack
  if (!verifySlackRequest(rawBody, timestamp, signature, signingSecret)) {
    console.error('Invalid Slack signature');
    console.error('Raw body:', rawBody);
    console.error('Timestamp:', timestamp);
    console.error('Signature:', signature);
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
