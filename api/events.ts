import { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { Octokit } from '@octokit/rest';
import { getUserInfo, initializeDatabase } from '../lib/db';

// Verify Slack request signature
function verifySlackRequest(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string
): boolean {
  const time = Math.floor(Date.now() / 1000);

  // Request is too old (replay attack prevention)
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

// Extract PR number from GitHub URL
function extractGitHubPRNumber(url: string): number | null {
  // Match: https://github.com/owner/repo/pull/123
  const githubMatch = url.match(/github\.com\/[\w-]+\/[\w-]+\/pull\/(\d+)/);
  if (githubMatch) {
    return parseInt(githubMatch[1], 10);
  }
  return null;
}

// Extract PR number from Graphite URL
function extractGraphitePRNumber(url: string): number | null {
  // Graphite URLs can be in formats like:
  // - https://app.graphite.dev/github/pr/owner/repo/123
  // - https://app.graphite.dev/github/pr/owner/repo/123/details
  const graphiteMatch = url.match(/graphite\.dev\/github\/pr\/[\w-]+\/[\w-]+\/(\d+)/);
  if (graphiteMatch) {
    return parseInt(graphiteMatch[1], 10);
  }
  return null;
}

// Extract PR number from any supported link
function extractPRNumber(text: string): number | null {
  // Look for GitHub URLs
  const githubUrlMatch = text.match(/https?:\/\/github\.com\/[\w-]+\/[\w-]+\/pull\/\d+/);
  if (githubUrlMatch) {
    return extractGitHubPRNumber(githubUrlMatch[0]);
  }

  // Look for Graphite URLs
  const graphiteUrlMatch = text.match(/https?:\/\/app\.graphite\.dev\/github\/pr\/[\w-]+\/[\w-]+\/\d+[^\s]*/);
  if (graphiteUrlMatch) {
    return extractGraphitePRNumber(graphiteUrlMatch[0]);
  }

  return null;
}

// Fetch message content from Slack
async function getMessage(
  channel: string,
  timestamp: string,
  botToken: string
): Promise<string | null> {
  try {
    const response = await fetch('https://slack.com/api/conversations.history', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel,
        latest: timestamp,
        limit: 1,
        inclusive: true,
      }),
    });

    const data = await response.json();

    if (!data.ok) {
      console.error('Failed to fetch message:', data.error);
      return null;
    }

    return data.messages?.[0]?.text || null;
  } catch (error: any) {
    console.error('Error fetching message:', error.message);
    return null;
  }
}

// Send DM to user
async function sendDM(userId: string, message: string, botToken: string): Promise<void> {
  try {
    // Open a DM channel
    const openResponse = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        users: userId,
      }),
    });

    const openData = await openResponse.json();

    if (!openData.ok) {
      console.error('Failed to open DM:', openData.error);
      return;
    }

    // Send message
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: openData.channel.id,
        text: message,
      }),
    });
  } catch (error: any) {
    console.error('Error sending DM:', error.message);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const botToken = process.env.SLACK_BOT_TOKEN;
  const githubOwner = process.env.GITHUB_OWNER;
  const githubRepo = process.env.GITHUB_REPO;
  const allowedChannels = process.env.SLACK_ALLOWED_CHANNELS?.split(',') || [];
  const triggerEmoji = process.env.TRIGGER_EMOJI || 'white_check_mark'; // ✅

  if (!signingSecret || !botToken || !githubOwner || !githubRepo) {
    console.error('Missing environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Get raw body for signature verification
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const timestamp = req.headers['x-slack-request-timestamp'] as string;
  const signature = req.headers['x-slack-signature'] as string;

  // Verify request is from Slack
  if (!verifySlackRequest(rawBody, timestamp, signature, signingSecret)) {
    console.error('Invalid Slack signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const body = JSON.parse(rawBody);

  // Handle URL verification challenge
  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }

  // Handle events
  if (body.type === 'event_callback') {
    const event = body.event;

    // Only process reaction_added events
    if (event.type !== 'reaction_added') {
      return res.status(200).json({ ok: true });
    }

    // Check if it's the trigger emoji
    if (event.reaction !== triggerEmoji) {
      return res.status(200).json({ ok: true });
    }

    // Check if channel is allowed (if restrictions are set)
    if (allowedChannels.length > 0 && !allowedChannels.includes(event.item.channel)) {
      console.log(`Ignoring reaction in channel ${event.item.channel} - not in allowed list`);
      return res.status(200).json({ ok: true });
    }

    // Respond immediately to Slack
    res.status(200).json({ ok: true });

    // Process the reaction in the background
    try {
      // Initialize database
      await initializeDatabase();

      // Get user's GitHub token
      const userInfo = await getUserInfo(event.user);

      if (!userInfo) {
        console.log(`User ${event.user} has not connected their GitHub account`);
        await sendDM(
          event.user,
          '⚠️ You need to connect your GitHub account first! Use `/connect` to link your account.',
          botToken
        );
        return;
      }

      // Fetch the message that was reacted to
      const messageText = await getMessage(
        event.item.channel,
        event.item.ts,
        botToken
      );

      if (!messageText) {
        console.log('Could not fetch message text');
        return;
      }

      // Extract PR number from the message
      const prNumber = extractPRNumber(messageText);

      if (!prNumber) {
        console.log('No PR link found in message:', messageText);
        return;
      }

      console.log(`Found PR #${prNumber}, approving as ${userInfo.username}...`);

      // Approve the PR using the user's token
      const octokit = new Octokit({ auth: userInfo.token });

      await octokit.pulls.createReview({
        owner: githubOwner,
        repo: githubRepo,
        pull_number: prNumber,
        event: 'APPROVE',
      });

      console.log(`✅ PR #${prNumber} approved by ${userInfo.username} (Slack user: ${event.user})`);
    } catch (error: any) {
      console.error('Failed to approve PR:', error.message);

      // Try to notify the user of the error
      try {
        await sendDM(
          event.user,
          `❌ Failed to approve PR: ${error.message}. Your GitHub token might be invalid or expired. Try using \`/connect\` again.`,
          botToken
        );
      } catch (dmError) {
        console.error('Failed to send error DM:', dmError);
      }
    }
  }
}
