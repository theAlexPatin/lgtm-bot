import { VercelRequest, VercelResponse } from '@vercel/node';
import { getRawBody, verifySlackRequest, parseBody } from '../lib/slack';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  console.log('=== CONNECT HANDLER START ===');
  console.log(`[${new Date().toISOString()}] Received ${req.method} request`);

  if (req.method !== 'POST') {
    console.log('❌ Rejecting non-POST request');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const baseUrl = process.env.BASE_URL || process.env.VERCEL_URL;

  console.log(`📋 Configuration - Base URL: ${baseUrl}`);

  if (!signingSecret || !githubClientId || !baseUrl) {
    console.error('❌ Missing environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  console.log('📥 Reading request body...');
  const rawBody = await getRawBody(req);
  console.log(`✓ Request body received (${rawBody.length} bytes)`);

  const timestamp = req.headers['x-slack-request-timestamp'] as string;
  const signature = req.headers['x-slack-signature'] as string;

  if (!timestamp || !signature) {
    console.error('❌ Missing Slack headers');
    return res.status(401).json({ error: 'Missing Slack headers' });
  }

  // Verify request is from Slack
  console.log('🔐 Verifying request signature...');
  if (!verifySlackRequest(rawBody, timestamp, signature, signingSecret)) {
    console.error('❌ Invalid Slack signature');
    console.error('Raw body:', rawBody);
    console.error('Timestamp:', timestamp);
    console.error('Signature:', signature);
    return res.status(401).json({ error: 'Invalid signature' });
  }
  console.log('✅ Signature verification passed');

  const data = parseBody(rawBody);
  const userId = data.user_id;

  console.log(`🔗 User ${userId} initiated GitHub account connection`);

  // Generate OAuth URL
  console.log('🔧 Generating OAuth URL...');
  const state = Buffer.from(JSON.stringify({ slack_user_id: userId })).toString('base64');
  const redirectUri = `https://${baseUrl}/api/oauth-callback`;

  const githubOAuthUrl = `https://github.com/login/oauth/authorize?client_id=${githubClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=repo`;

  console.log(`✓ OAuth URL generated`);
  console.log(`Redirect URI: ${redirectUri}`);

  // Respond to Slack with instructions
  console.log('📤 Sending OAuth button response to Slack...');
  const response = res.status(200).json({
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
  console.log('✅ Response sent');
  console.log('=== CONNECT HANDLER COMPLETE ===\n');
  return response;
}
