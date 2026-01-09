import { VercelRequest, VercelResponse } from '@vercel/node';
import { Octokit } from '@octokit/rest';
import crypto from 'crypto';
import { getUserInfo, initializeDatabase } from '../lib/db';
import { getRawBody, verifySlackRequest } from '../lib/slack';

// Extract all PR numbers from any URLs containing owner/repo/number pattern
function extractPRNumbers(text: string, owner: string, repo: string): number[] {
  // Slack formats links as <URL|text> or just <URL>
  // Extract all URLs from Slack format first
  const slackLinkPattern = /<(https?:\/\/[^|>]+)(?:\|[^>]+)?>/g;
  const slackLinks = [...text.matchAll(slackLinkPattern)].map(match => match[1]);

  // Also look for plain URLs
  const plainUrls = text.match(/https?:\/\/[^\s<>]+/g) || [];

  // Combine both types of URLs
  const allUrls = [...slackLinks, ...plainUrls];

  // Look for URLs containing the specific owner/repo pattern
  // This covers:
  // - GitHub: https://github.com/owner/repo/pull/123
  // - Graphite: https://app.graphite.com/github/pr/owner/repo/123
  // - Any other service with similar pattern
  const escapedOwner = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\/${escapedOwner}\\/${escapedRepo}\\/(?:pull\\/)?(\\d+)`, 'i');

  const prNumbers: number[] = [];
  const seen = new Set<number>();

  for (const url of allUrls) {
    const prMatch = url.match(pattern);
    if (prMatch) {
      const prNumber = parseInt(prMatch[1], 10);
      // Avoid duplicates
      if (!seen.has(prNumber)) {
        seen.add(prNumber);
        prNumbers.push(prNumber);
      }
    }
  }

  return prNumbers;
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

    const data = await response.json() as any;

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

    const openData = await openResponse.json() as any;

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
  const rawBody = await getRawBody(req);

  // Parse body - could be JSON or form-encoded
  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    // If JSON parsing fails, try to parse as URL-encoded form data
    const params = new URLSearchParams(rawBody);

    // Check if it's a nested payload or direct form data
    const payload = params.get('payload');
    if (payload) {
      body = JSON.parse(payload);
    } else {
      // Direct form data (like challenge requests)
      body = {};
      params.forEach((value, key) => {
        body[key] = value;
      });
    }
  }

  // Handle URL verification challenge BEFORE signature verification
  // Slack's challenge request is sent during initial setup and may not have proper signature
  if (body.type === 'url_verification') {
    console.log('Responding to URL verification challenge');
    return res.status(200).json({ challenge: body.challenge });
  }

  // For actual events, verify the signature
  const timestamp = req.headers['x-slack-request-timestamp'] as string;
  const signature = req.headers['x-slack-signature'] as string;

  if (!timestamp || !signature) {
    console.error('Missing Slack headers');
    return res.status(401).json({ error: 'Missing Slack headers' });
  }

  // Verify request is from Slack
  // Note: Signature verification may fail because Vercel parses the body and we can't reconstruct it exactly
  const skipVerification = process.env.SKIP_SLACK_VERIFICATION === 'true';

  if (!skipVerification && !verifySlackRequest(rawBody, timestamp, signature, signingSecret)) {
    console.error('Invalid Slack signature - body reconstruction may not match original');
    console.error('Raw body (first 200 chars):', rawBody.substring(0, 200));
    console.error('Raw body length:', rawBody.length);
    console.error('Timestamp:', timestamp);
    console.error('Signature received:', signature);
    console.error('Content-Type:', req.headers['content-type']);

    // Log what we're verifying against
    const sigBasestring = `v0:${timestamp}:${rawBody}`;
    const expectedSig = `v0=${crypto.createHmac('sha256', signingSecret).update(sigBasestring, 'utf8').digest('hex')}`;
    console.error('Expected signature:', expectedSig);

    return res.status(401).json({ error: 'Invalid signature' });
  }

  if (skipVerification) {
    console.warn('⚠️  Slack signature verification is DISABLED - only use this in development!');
  }

  // Handle events
  if (body.type === 'event_callback') {
    const event = body.event;

    console.log('Received event:', JSON.stringify(event, null, 2));

    // Only process reaction_added events
    if (event.type !== 'reaction_added') {
      console.log(`Ignoring event type: ${event.type}`);
      return res.status(200).json({ ok: true });
    }

    // Check if it's the trigger emoji
    console.log(`Reaction: ${event.reaction}, Looking for: ${triggerEmoji}`);
    if (event.reaction !== triggerEmoji) {
      console.log(`Ignoring reaction ${event.reaction} - not the trigger emoji`);
      return res.status(200).json({ ok: true });
    }

    // Check if channel is allowed (if restrictions are set)
    if (allowedChannels.length > 0 && !allowedChannels.includes(event.item.channel)) {
      console.log(`Ignoring reaction in channel ${event.item.channel} - not in allowed list`);
      return res.status(200).json({ ok: true });
    }

    console.log(`✅ Received ${triggerEmoji} reaction from user ${event.user} in channel ${event.item.channel}`);

    // Process the reaction synchronously
    try {
      // Initialize database
      await initializeDatabase();

      // Get user's GitHub token
      const userInfo = await getUserInfo(event.user);

      if (!userInfo) {
        const appName = process.env.APP_NAME || 'lgtm';
        console.log(`User ${event.user} has not connected their GitHub account`);
        await sendDM(
          event.user,
          `⚠️ You need to connect your GitHub account first! Use \`/${appName} connect\` to link your account.`,
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

      // Extract all PR numbers from the message
      const prNumbers = extractPRNumbers(messageText, githubOwner, githubRepo);

      if (prNumbers.length === 0) {
        console.log('No PR links found in message:', messageText);
        return;
      }

      console.log(`Found ${prNumbers.length} PR(s): ${prNumbers.join(', ')}, approving as ${userInfo.username}...`);

      // Approve all PRs using the user's token
      const octokit = new Octokit({ auth: userInfo.token });

      const approvalResults = [];
      for (const prNumber of prNumbers) {
        try {
          await octokit.pulls.createReview({
            owner: githubOwner,
            repo: githubRepo,
            pull_number: prNumber,
            event: 'APPROVE',
          });

          console.log(`✅ PR #${prNumber} approved by ${userInfo.username} (Slack user: ${event.user})`);
          approvalResults.push({ prNumber, status: 'success' });
        } catch (prError: any) {
          console.error(`Failed to approve PR #${prNumber}:`, prError.message);
          approvalResults.push({ prNumber, status: 'failed', error: prError.message });
        }
      }

      // Log summary
      const successCount = approvalResults.filter(r => r.status === 'success').length;
      const failureCount = approvalResults.filter(r => r.status === 'failed').length;
      console.log(`Approval summary: ${successCount} succeeded, ${failureCount} failed`);

      // Send success response
      return res.status(200).json({ ok: true });
    } catch (error: any) {
      console.error('Failed to approve PR:', error.message);
      console.error('Error stack:', error.stack);

      // Try to notify the user of the error
      try {
        const appName = process.env.APP_NAME || 'lgtm';
        await sendDM(
          event.user,
          `❌ Failed to approve PR: ${error.message}. Your GitHub token might be invalid or expired. Try using \`/${appName} connect\` again.`,
          botToken
        );
      } catch (dmError) {
        console.error('Failed to send error DM:', dmError);
      }

      // Send response even on error
      return res.status(200).json({ ok: true });
    }
  }

  // Default response for other event types
  return res.status(200).json({ ok: true });
}
