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
    // Decode state to get Slack user ID
    const stateData = JSON.parse(Buffer.from(state as string, 'base64').toString());
    const slackUserId = stateData.slack_user_id;

    // Exchange code for access token
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

    if (tokenData.error || !tokenData.access_token) {
      console.error('GitHub OAuth error:', tokenData.error_description);
      return res.status(400).send('Failed to authenticate with GitHub');
    }

    const accessToken = tokenData.access_token;

    // Get GitHub username
    const octokit = new Octokit({ auth: accessToken });
    const { data: user } = await octokit.users.getAuthenticated();

    // Initialize database and store token
    await initializeDatabase();
    await storeUserToken(slackUserId, accessToken, user.login);

    // Return success page
    return res.status(200).send(`
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
    `);
  } catch (error: any) {
    console.error('OAuth callback error:', error.message);
    return res.status(500).send('An error occurred during authentication');
  }
}
