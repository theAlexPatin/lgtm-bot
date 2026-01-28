import { VercelRequest, VercelResponse } from '@vercel/node';
import { Octokit } from '@octokit/rest';
import crypto from 'crypto';
import { getUserInfo, initializeDatabase } from '../lib/db';
import { getRawBody, verifySlackRequest } from '../lib/slack';

interface PRInfo {
  owner: string;
  repo: string;
  prNumber: number;
}

// Extract user mentions from Slack message text
// Slack formats user mentions as <@USER_ID> or <@USER_ID|username>
function extractUserMentions(text: string): string[] {
  const mentionPattern = /<@([A-Z0-9]+)(?:\|[^>]+)?>/g;
  const mentions: string[] = [];
  let match;
  while ((match = mentionPattern.exec(text)) !== null) {
    mentions.push(match[1]);
  }
  return mentions;
}

// Add a reaction to a message
async function addReaction(
  channel: string,
  timestamp: string,
  emoji: string,
  botToken: string
): Promise<boolean> {
  try {
    const response = await fetch('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel,
        timestamp,
        name: emoji,
      }),
    });

    const data = await response.json() as any;

    if (!data.ok) {
      // already_reacted is not an error for our purposes
      if (data.error === 'already_reacted') {
        return true;
      }
      console.error('Failed to add reaction:', data.error);
      return false;
    }

    return true;
  } catch (error: any) {
    console.error('Error adding reaction:', error.message);
    return false;
  }
}

// Get the bot's user ID
async function getBotUserId(botToken: string): Promise<string | null> {
  try {
    const response = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json() as any;

    if (!data.ok) {
      console.error('Failed to get bot user ID:', data.error);
      return null;
    }

    return data.user_id;
  } catch (error: any) {
    console.error('Error getting bot user ID:', error.message);
    return null;
  }
}

// Check if a user has already approved a PR
async function hasAlreadyApproved(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  githubUsername: string
): Promise<boolean> {
  try {
    const { data: reviews } = await octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
    });

    // Check if any review from this user is an approval
    // We check for the most recent review state from this user
    const userReviews = reviews.filter(
      review => review.user?.login?.toLowerCase() === githubUsername.toLowerCase()
    );

    if (userReviews.length === 0) {
      return false;
    }

    // Get the most recent review from this user
    const latestReview = userReviews[userReviews.length - 1];
    return latestReview.state === 'APPROVED';
  } catch (error: any) {
    console.error(`Error checking existing reviews for ${owner}/${repo}#${prNumber}:`, error.message);
    // If we can't check, proceed with the approval attempt
    return false;
  }
}

// Extract all PR information from any URLs in the text
function extractPRs(text: string): PRInfo[] {
  // Slack formats links as <URL|text> or just <URL>
  // Extract all URLs from Slack format first
  const slackLinkPattern = /<(https?:\/\/[^|>]+)(?:\|[^>]+)?>/g;
  const slackLinks = [...text.matchAll(slackLinkPattern)].map(match => match[1]);

  // Also look for plain URLs
  const plainUrls = text.match(/https?:\/\/[^\s<>]+/g) || [];

  // Combine both types of URLs
  const allUrls = [...slackLinks, ...plainUrls];

  // Look for URLs containing owner/repo/pull patterns
  // This covers:
  // - GitHub: https://github.com/owner/repo/pull/123
  // - Graphite: https://app.graphite.com/github/pr/owner/repo/123
  const githubPattern = /github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/i;
  const graphitePattern = /graphite\.(?:com|dev)\/github\/pr\/([^\/]+)\/([^\/]+)\/(\d+)/i;

  const prs: PRInfo[] = [];
  const seen = new Set<string>();

  for (const url of allUrls) {
    let match = url.match(githubPattern);
    if (!match) {
      match = url.match(graphitePattern);
    }

    if (match) {
      const owner = match[1];
      const repo = match[2];
      const prNumber = parseInt(match[3], 10);
      const key = `${owner}/${repo}/${prNumber}`;

      // Avoid duplicates
      if (!seen.has(key)) {
        seen.add(key);
        prs.push({ owner, repo, prNumber });
      }
    }
  }

  return prs;
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
  const allowedChannels = process.env.SLACK_ALLOWED_CHANNELS?.split(',') || [];
  const triggerEmoji = process.env.TRIGGER_EMOJI || 'white_check_mark'; // ✅

  if (!signingSecret || !botToken) {
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

    // Get bot user ID to avoid responding to our own actions
    const botUserId = await getBotUserId(botToken);

    // Handle message events - for @mention approval flow
    if (event.type === 'message' && !event.subtype) {
      const messageText = event.text || '';
      const channel = event.channel;
      const messageTs = event.ts;
      const senderId = event.user;

      // Ignore messages from the bot itself
      if (senderId === botUserId) {
        console.log('Ignoring message from bot itself');
        return res.status(200).json({ ok: true });
      }

      // Check if channel is allowed (if restrictions are set)
      if (allowedChannels.length > 0 && !allowedChannels.includes(channel)) {
        console.log(`Ignoring message in channel ${channel} - not in allowed list`);
        return res.status(200).json({ ok: true });
      }

      // Extract user mentions and PR links
      const mentionedUsers = extractUserMentions(messageText);
      const prs = extractPRs(messageText);

      // If no user mentions, skip (default to normal reaction-based behavior)
      if (mentionedUsers.length === 0) {
        console.log('No user mentions in message, skipping');
        return res.status(200).json({ ok: true });
      }

      // If no PR links, skip
      if (prs.length === 0) {
        console.log('No PR links found in message with mentions');
        return res.status(200).json({ ok: true });
      }

      console.log(`Found ${mentionedUsers.length} mentioned user(s) and ${prs.length} PR(s)`);

      try {
        // Initialize database
        await initializeDatabase();

        const prSummary = prs.map(pr => `${pr.owner}/${pr.repo}#${pr.prNumber}`).join(', ');
        let anySuccess = false;

        // Process each mentioned user
        for (const mentionedUserId of mentionedUsers) {
          const userInfo = await getUserInfo(mentionedUserId);

          if (!userInfo) {
            const appName = process.env.APP_NAME || 'lgtm';
            console.log(`Mentioned user ${mentionedUserId} has not connected their GitHub account`);
            await sendDM(
              senderId,
              `⚠️ <@${mentionedUserId}> has not connected their GitHub account. They need to use \`/${appName} connect\` to link their account.`,
              botToken
            );
            continue;
          }

          console.log(`Approving ${prSummary} as ${userInfo.username} (mentioned Slack user: ${mentionedUserId})...`);

          // Approve all PRs using the mentioned user's token
          const octokit = new Octokit({ auth: userInfo.token });

          for (const pr of prs) {
            try {
              // Check if user has already approved this PR
              const alreadyApproved = await hasAlreadyApproved(
                octokit,
                pr.owner,
                pr.repo,
                pr.prNumber,
                userInfo.username
              );

              if (alreadyApproved) {
                console.log(`⏭️ ${pr.owner}/${pr.repo}#${pr.prNumber} already approved by ${userInfo.username}, skipping`);
                anySuccess = true; // Still count as success for reaction purposes
                continue;
              }

              await octokit.pulls.createReview({
                owner: pr.owner,
                repo: pr.repo,
                pull_number: pr.prNumber,
                event: 'APPROVE',
              });

              console.log(`✅ ${pr.owner}/${pr.repo}#${pr.prNumber} approved by ${userInfo.username} (on behalf of Slack user: ${mentionedUserId})`);
              anySuccess = true;
            } catch (prError: any) {
              console.error(`Failed to approve ${pr.owner}/${pr.repo}#${pr.prNumber} as ${userInfo.username}:`, prError.message);
              await sendDM(
                senderId,
                `❌ Failed to approve ${pr.owner}/${pr.repo}#${pr.prNumber} as ${userInfo.username}: ${prError.message}`,
                botToken
              );
            }
          }
        }

        // Add checkmark reaction to indicate completion if any approval succeeded
        if (anySuccess) {
          await addReaction(channel, messageTs, triggerEmoji, botToken);
          console.log(`Added ${triggerEmoji} reaction to message`);
        }

        return res.status(200).json({ ok: true });
      } catch (error: any) {
        console.error('Failed to process mention-based approval:', error.message);
        console.error('Error stack:', error.stack);
        return res.status(200).json({ ok: true });
      }
    }

    // Handle reaction_added events - original approval flow
    if (event.type !== 'reaction_added') {
      console.log(`Ignoring event type: ${event.type}`);
      return res.status(200).json({ ok: true });
    }

    // Ignore reactions from the bot itself (e.g., our own checkmark reactions)
    if (event.user === botUserId) {
      console.log('Ignoring reaction from bot itself');
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

      // Extract all PR information from the message
      const prs = extractPRs(messageText);

      if (prs.length === 0) {
        console.log('No PR links found in message:', messageText);
        return;
      }

      const prSummary = prs.map(pr => `${pr.owner}/${pr.repo}#${pr.prNumber}`).join(', ');
      console.log(`Found ${prs.length} PR(s): ${prSummary}, approving as ${userInfo.username}...`);

      // Approve all PRs using the user's token
      const octokit = new Octokit({ auth: userInfo.token });

      const approvalResults = [];
      for (const pr of prs) {
        try {
          // Check if user has already approved this PR
          const alreadyApproved = await hasAlreadyApproved(
            octokit,
            pr.owner,
            pr.repo,
            pr.prNumber,
            userInfo.username
          );

          if (alreadyApproved) {
            console.log(`⏭️ ${pr.owner}/${pr.repo}#${pr.prNumber} already approved by ${userInfo.username}, skipping`);
            approvalResults.push({ pr, status: 'skipped' });
            continue;
          }

          await octokit.pulls.createReview({
            owner: pr.owner,
            repo: pr.repo,
            pull_number: pr.prNumber,
            event: 'APPROVE',
          });

          console.log(`✅ ${pr.owner}/${pr.repo}#${pr.prNumber} approved by ${userInfo.username} (Slack user: ${event.user})`);
          approvalResults.push({ pr, status: 'success' });
        } catch (prError: any) {
          console.error(`Failed to approve ${pr.owner}/${pr.repo}#${pr.prNumber}:`, prError.message);
          approvalResults.push({ pr, status: 'failed', error: prError.message });
        }
      }

      // Log summary
      const successCount = approvalResults.filter(r => r.status === 'success').length;
      const skippedCount = approvalResults.filter(r => r.status === 'skipped').length;
      const failureCount = approvalResults.filter(r => r.status === 'failed').length;
      console.log(`Approval summary: ${successCount} succeeded, ${skippedCount} skipped (already approved), ${failureCount} failed`);

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
