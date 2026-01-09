import { VercelRequest, VercelResponse } from '@vercel/node';
import { Octokit } from '@octokit/rest';
import { storeUserToken, initializeDatabase } from '../../lib/db';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, state } = req.query;

  if (!code || !state) {
    return res.status(400).send('Missing code or state parameter');
  }

  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!githubClientId || !githubClientSecret) {
    console.error('Missing GitHub OAuth credentials');
    return res.status(500).send('Server configuration error');
  }

  try {
    console.log('Starting OAuth callback...');

    // Decode state to get Slack user ID
    const stateData = JSON.parse(Buffer.from(state as string, 'base64').toString());
    const slackUserId = stateData.slack_user_id;
    console.log('Slack user ID:', slackUserId);

    // Exchange code for access token
    console.log('Exchanging code for token...');
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: githubClientId,
        client_secret: githubClientSecret,
        code,
      }),
    });

    const tokenData = await tokenResponse.json() as any;
    console.log('Token response received');

    if (tokenData.error || !tokenData.access_token) {
      console.error('GitHub OAuth error:', tokenData.error_description || tokenData.error);
      return res.status(400).send(`Failed to authenticate with GitHub: ${tokenData.error_description || tokenData.error}`);
    }

    const accessToken = tokenData.access_token;
    console.log('Access token obtained');

    // Get GitHub username
    console.log('Fetching GitHub user info...');
    const octokit = new Octokit({ auth: accessToken });
    const { data: user } = await octokit.users.getAuthenticated();
    console.log('GitHub username:', user.login);

    // Initialize database and store token
    console.log('Initializing database...');
    await initializeDatabase();
    console.log('Database initialized, storing user token...');
    await storeUserToken(slackUserId, accessToken, user.login);
    console.log(`✅ Successfully linked GitHub account @${user.login} to Slack user ${slackUserId}`);

    // Return success page
    console.log('Sending success response...');
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>GitHub Connected</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            .container {
              background: white;
              padding: 3rem;
              border-radius: 1rem;
              box-shadow: 0 20px 60px rgba(0,0,0,0.3);
              text-align: center;
              max-width: 400px;
            }
            .success-icon {
              font-size: 4rem;
              margin-bottom: 1rem;
            }
            h1 {
              color: #333;
              margin: 0 0 1rem 0;
              font-size: 1.75rem;
            }
            p {
              color: #666;
              line-height: 1.6;
              margin: 0 0 1.5rem 0;
            }
            .username {
              background: #f0f0f0;
              padding: 0.5rem 1rem;
              border-radius: 0.5rem;
              font-family: 'Monaco', 'Courier New', monospace;
              color: #333;
              font-weight: 600;
            }
            .close-note {
              color: #999;
              font-size: 0.9rem;
              margin-top: 1.5rem;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success-icon">✅</div>
            <h1>Successfully Connected!</h1>
            <p>Your GitHub account has been linked to LGTM Bot.</p>
            <div class="username">@${user.login}</div>
            <p class="close-note">You can close this window and return to Slack.</p>
          </div>
        </body>
      </html>
    `;

    res.status(200).send(html);
    console.log('Success response sent');
    return;
  } catch (error: any) {
    console.error('OAuth callback error:', error);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    return res.status(500).send(`An error occurred during authentication: ${error.message}`);
  }
}
