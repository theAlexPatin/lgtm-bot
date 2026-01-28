import { VercelRequest, VercelResponse } from '@vercel/node';
import { Octokit } from '@octokit/rest';
import crypto from 'crypto';
import { getUserInfo, initializeDatabase } from '../lib/db';
import { getRawBody, verifySlackRequest } from '../lib/slack';

// Disable body parsing so we can access the raw body for signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};

interface PRInfo {
  owner: string;
  repo: string;
  prNumber: number;
}

// Extract user mentions from Slack message text
// Slack formats user mentions as <@USER_ID> or <@USER_ID|username>
function extractUserMentions(text: string): string[] {
  console.log('[extractUserMentions] Extracting user mentions from text...');
  const mentionPattern = /<@([A-Z0-9]+)(?:\|[^>]+)?>/g;
  const mentions: string[] = [];
  let match;
  while ((match = mentionPattern.exec(text)) !== null) {
    mentions.push(match[1]);
  }
  console.log(`[extractUserMentions] Found ${mentions.length} mention(s): ${mentions.join(', ')}`);
  return mentions;
}

// Add a reaction to a message
async function addReaction(
  channel: string,
  timestamp: string,
  emoji: string,
  botToken: string
): Promise<boolean> {
  console.log(`[addReaction] Adding :${emoji}: to message ${timestamp} in channel ${channel}`);
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
        console.log(`[addReaction] ✓ Reaction already exists`);
        return true;
      }
      console.error(`[addReaction] ❌ Failed to add reaction: ${data.error}`);
      return false;
    }

    console.log(`[addReaction] ✓ Reaction added successfully`);
    return true;
  } catch (error: any) {
    console.error(`[addReaction] ❌ Error: ${error.message}`);
    return false;
  }
}

// Get the bot's user ID
async function getBotUserId(botToken: string): Promise<string | null> {
  console.log('[getBotUserId] Fetching bot user ID from Slack...');
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
      console.error(`[getBotUserId] ❌ Failed: ${data.error}`);
      return null;
    }

    console.log(`[getBotUserId] ✓ Bot user ID: ${data.user_id}`);
    return data.user_id;
  } catch (error: any) {
    console.error(`[getBotUserId] ❌ Error: ${error.message}`);
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
  console.log(`[hasAlreadyApproved] Checking if ${githubUsername} already approved ${owner}/${repo}#${prNumber}...`);
  try {
    const { data: reviews } = await octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
    });

    console.log(`[hasAlreadyApproved] Found ${reviews.length} total review(s) on this PR`);

    // Check if any review from this user is an approval
    // We check for the most recent review state from this user
    const userReviews = reviews.filter(
      review => review.user?.login?.toLowerCase() === githubUsername.toLowerCase()
    );

    console.log(`[hasAlreadyApproved] Found ${userReviews.length} review(s) from ${githubUsername}`);

    if (userReviews.length === 0) {
      console.log(`[hasAlreadyApproved] ✓ No previous reviews from ${githubUsername}`);
      return false;
    }

    // Get the most recent review from this user
    const latestReview = userReviews[userReviews.length - 1];
    const isApproved = latestReview.state === 'APPROVED';
    console.log(`[hasAlreadyApproved] Latest review state: ${latestReview.state} - Already approved: ${isApproved}`);
    return isApproved;
  } catch (error: any) {
    console.error(`[hasAlreadyApproved] ❌ Error checking reviews for ${owner}/${repo}#${prNumber}: ${error.message}`);
    // If we can't check, proceed with the approval attempt
    return false;
  }
}

// Extract all PR information from any URLs in the text
function extractPRs(text: string): PRInfo[] {
  console.log('[extractPRs] Extracting PR links from text...');
  // Slack formats links as <URL|text> or just <URL>
  // Extract all URLs from Slack format first
  const slackLinkPattern = /<(https?:\/\/[^|>]+)(?:\|[^>]+)?>/g;
  const slackLinks = [...text.matchAll(slackLinkPattern)].map(match => match[1]);
  console.log(`[extractPRs] Found ${slackLinks.length} Slack-formatted link(s)`);

  // Also look for plain URLs
  const plainUrls = text.match(/https?:\/\/[^\s<>]+/g) || [];
  console.log(`[extractPRs] Found ${plainUrls.length} plain URL(s)`);

  // Combine both types of URLs
  const allUrls = [...slackLinks, ...plainUrls];
  console.log(`[extractPRs] Total URLs to check: ${allUrls.length}`);

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
    let source = 'GitHub';
    if (!match) {
      match = url.match(graphitePattern);
      source = 'Graphite';
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
        console.log(`[extractPRs] ✓ Found ${source} PR: ${key} from ${url}`);
      } else {
        console.log(`[extractPRs] ⏭️ Skipping duplicate: ${key}`);
      }
    }
  }

  console.log(`[extractPRs] Extracted ${prs.length} unique PR(s)`);
  return prs;
}

// Fetch message content from Slack
async function getMessage(
  channel: string,
  timestamp: string,
  botToken: string
): Promise<string | null> {
  console.log(`[getMessage] Fetching message ${timestamp} from channel ${channel}`);
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
      console.error(`[getMessage] ❌ Failed: ${data.error}`);
      return null;
    }

    const text = data.messages?.[0]?.text || null;
    if (text) {
      console.log(`[getMessage] ✓ Message fetched (${text.length} chars)`);
    } else {
      console.log(`[getMessage] ⚠️ No message text found`);
    }
    return text;
  } catch (error: any) {
    console.error(`[getMessage] ❌ Error: ${error.message}`);
    return null;
  }
}

// Send DM to user
async function sendDM(userId: string, message: string, botToken: string): Promise<void> {
  console.log(`[sendDM] Sending DM to user ${userId}`);
  console.log(`[sendDM] Message: "${message.substring(0, 100)}${message.length > 100 ? '...' : ''}"`);
  try {
    // Open a DM channel
    console.log(`[sendDM] Opening DM channel...`);
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
      console.error(`[sendDM] ❌ Failed to open DM: ${openData.error}`);
      return;
    }

    console.log(`[sendDM] ✓ DM channel opened: ${openData.channel.id}`);

    // Send message
    console.log(`[sendDM] Posting message...`);
    const sendResponse = await fetch('https://slack.com/api/chat.postMessage', {
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

    const sendData = await sendResponse.json() as any;
    if (sendData.ok) {
      console.log(`[sendDM] ✓ Message sent successfully`);
    } else {
      console.error(`[sendDM] ❌ Failed to send message: ${sendData.error}`);
    }
  } catch (error: any) {
    console.error(`[sendDM] ❌ Error: ${error.message}`);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  console.log('=== EVENT HANDLER START ===');
  console.log(`[${new Date().toISOString()}] Received ${req.method} request`);

  // Only accept POST requests
  if (req.method !== 'POST') {
    console.log('❌ Rejecting non-POST request');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const botToken = process.env.SLACK_BOT_TOKEN;
  const allowedChannels = process.env.SLACK_ALLOWED_CHANNELS?.split(',') || [];
  const triggerEmoji = process.env.TRIGGER_EMOJI || 'white_check_mark'; // ✅

  console.log(`📋 Configuration loaded - Trigger emoji: ${triggerEmoji}, Allowed channels: ${allowedChannels.length > 0 ? allowedChannels.join(', ') : 'all'}`);

  if (!signingSecret || !botToken) {
    console.error('❌ Missing environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Get raw body for signature verification
  console.log('📥 Reading request body...');
  const rawBody = await getRawBody(req);
  console.log(`✓ Request body received (${rawBody.length} bytes)`);

  // Parse body - could be JSON or form-encoded
  let body: any;
  try {
    console.log('🔍 Parsing request body as JSON...');
    body = JSON.parse(rawBody);
    console.log('✓ Body parsed as JSON');
  } catch (e) {
    console.log('🔄 JSON parsing failed, trying URL-encoded format...');
    // If JSON parsing fails, try to parse as URL-encoded form data
    const params = new URLSearchParams(rawBody);

    // Check if it's a nested payload or direct form data
    const payload = params.get('payload');
    if (payload) {
      console.log('✓ Found nested payload, parsing...');
      body = JSON.parse(payload);
    } else {
      console.log('✓ Parsing as direct form data...');
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
    console.log('✅ Responding to URL verification challenge');
    return res.status(200).json({ challenge: body.challenge });
  }

  // For actual events, verify the signature
  console.log('🔐 Verifying request signature...');
  const timestamp = req.headers['x-slack-request-timestamp'] as string;
  const signature = req.headers['x-slack-signature'] as string;

  if (!timestamp || !signature) {
    console.error('❌ Missing Slack headers');
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
  } else {
    console.log('✅ Signature verification passed');
  }

  // Handle events
  if (body.type === 'event_callback') {
    const event = body.event;

    console.log('📨 Received event callback');
    console.log(`Event type: ${event.type}`);
    console.log('Event details:', JSON.stringify(event, null, 2));

    // Get bot user ID to avoid responding to our own actions
    console.log('🤖 Fetching bot user ID...');
    const botUserId = await getBotUserId(botToken);
    console.log(`✓ Bot user ID: ${botUserId}`);

    // Handle message events - for @mention approval flow
    if (event.type === 'message' && !event.subtype) {
      console.log('💬 Processing message event');
      const messageText = event.text || '';
      const channel = event.channel;
      const messageTs = event.ts;
      const senderId = event.user;

      console.log(`Message from: ${senderId} in channel: ${channel}`);
      console.log(`Message text: "${messageText.substring(0, 100)}${messageText.length > 100 ? '...' : ''}"`);

      // Ignore messages from the bot itself
      if (senderId === botUserId) {
        console.log('⏭️ Ignoring message from bot itself');
        return res.status(200).json({ ok: true });
      }

      // Check if channel is allowed (if restrictions are set)
      if (allowedChannels.length > 0 && !allowedChannels.includes(channel)) {
        console.log(`⏭️ Ignoring message in channel ${channel} - not in allowed list`);
        return res.status(200).json({ ok: true });
      }

      // Extract user mentions and PR links
      console.log('🔍 Extracting user mentions from message...');
      const mentionedUsers = extractUserMentions(messageText);
      console.log(`✓ Found ${mentionedUsers.length} user mention(s): ${mentionedUsers.join(', ')}`);

      console.log('🔍 Extracting PR links from message...');
      const prs = extractPRs(messageText);
      console.log(`✓ Found ${prs.length} PR(s): ${prs.map(pr => `${pr.owner}/${pr.repo}#${pr.prNumber}`).join(', ')}`);

      // If no user mentions, skip (default to normal reaction-based behavior)
      if (mentionedUsers.length === 0) {
        console.log('⏭️ No user mentions in message, skipping @mention flow');
        return res.status(200).json({ ok: true });
      }

      // If no PR links, skip
      if (prs.length === 0) {
        console.log('⏭️ No PR links found in message with mentions');
        return res.status(200).json({ ok: true });
      }

      console.log(`✅ Starting @mention approval flow: ${mentionedUsers.length} user(s), ${prs.length} PR(s)`);

      try {
        // Initialize database
        console.log('💾 Initializing database...');
        await initializeDatabase();
        console.log('✓ Database initialized');

        const prSummary = prs.map(pr => `${pr.owner}/${pr.repo}#${pr.prNumber}`).join(', ');
        let anySuccess = false;
        let processedCount = 0;

        // Process each mentioned user
        console.log(`👥 Processing ${mentionedUsers.length} mentioned user(s)...`);
        for (const mentionedUserId of mentionedUsers) {
          processedCount++;
          console.log(`\n[${processedCount}/${mentionedUsers.length}] Processing user: ${mentionedUserId}`);
          console.log('📋 Fetching user GitHub info from database...');
          const userInfo = await getUserInfo(mentionedUserId);

          if (!userInfo) {
            const appName = process.env.APP_NAME || 'lgtm';
            console.log(`❌ User ${mentionedUserId} has not connected their GitHub account`);
            console.log('📤 Sending DM to message sender...');
            await sendDM(
              senderId,
              `⚠️ <@${mentionedUserId}> has not connected their GitHub account. They need to use \`/${appName} connect\` to link their account.`,
              botToken
            );
            console.log('✓ DM sent');
            continue;
          }

          console.log(`✓ Found GitHub account: @${userInfo.username}`);
          console.log(`🚀 Starting approval process for ${prSummary} as ${userInfo.username}...`);

          // Approve all PRs using the mentioned user's token
          const octokit = new Octokit({ auth: userInfo.token });
          let prCount = 0;

          for (const pr of prs) {
            prCount++;
            console.log(`\n  [PR ${prCount}/${prs.length}] Processing ${pr.owner}/${pr.repo}#${pr.prNumber}`);
            try {
              // Check if user has already approved this PR
              console.log('  🔍 Checking existing approvals...');
              const alreadyApproved = await hasAlreadyApproved(
                octokit,
                pr.owner,
                pr.repo,
                pr.prNumber,
                userInfo.username
              );

              if (alreadyApproved) {
                console.log(`  ⏭️ Already approved by ${userInfo.username}, skipping`);
                anySuccess = true; // Still count as success for reaction purposes
                continue;
              }

              console.log('  ✓ Not yet approved, creating approval review...');
              await octokit.pulls.createReview({
                owner: pr.owner,
                repo: pr.repo,
                pull_number: pr.prNumber,
                event: 'APPROVE',
              });

              console.log(`  ✅ Successfully approved by ${userInfo.username} (on behalf of: <@${mentionedUserId}>)`);
              anySuccess = true;
            } catch (prError: any) {
              console.error(`  ❌ Failed to approve: ${prError.message}`);
              console.log('  📤 Sending error DM to message sender...');
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
          console.log(`\n✅ At least one approval succeeded, adding ${triggerEmoji} reaction...`);
          await addReaction(channel, messageTs, triggerEmoji, botToken);
          console.log('✓ Reaction added');
        } else {
          console.log('\n⚠️ No approvals succeeded, not adding reaction');
        }

        console.log('=== @MENTION FLOW COMPLETE ===\n');
        return res.status(200).json({ ok: true });
      } catch (error: any) {
        console.error('❌ Failed to process mention-based approval:', error.message);
        console.error('Error stack:', error.stack);
        return res.status(200).json({ ok: true });
      }
    }

    // Handle reaction_added events - original approval flow
    if (event.type !== 'reaction_added') {
      console.log(`⏭️ Ignoring event type: ${event.type}`);
      return res.status(200).json({ ok: true });
    }

    console.log('👍 Processing reaction_added event');

    // Ignore reactions from the bot itself (e.g., our own checkmark reactions)
    if (event.user === botUserId) {
      console.log('⏭️ Ignoring reaction from bot itself');
      return res.status(200).json({ ok: true });
    }

    // Check if it's the trigger emoji
    console.log(`🔍 Checking reaction: "${event.reaction}" (looking for: "${triggerEmoji}")`);
    if (event.reaction !== triggerEmoji) {
      console.log(`⏭️ Ignoring reaction "${event.reaction}" - not the trigger emoji`);
      return res.status(200).json({ ok: true });
    }

    // Check if channel is allowed (if restrictions are set)
    if (allowedChannels.length > 0 && !allowedChannels.includes(event.item.channel)) {
      console.log(`⏭️ Ignoring reaction in channel ${event.item.channel} - not in allowed list`);
      return res.status(200).json({ ok: true });
    }

    console.log(`✅ Valid ${triggerEmoji} reaction from user ${event.user} in channel ${event.item.channel}`);
    console.log('🚀 Starting reaction-based approval flow...');

    // Process the reaction synchronously
    try {
      // Initialize database
      console.log('💾 Initializing database...');
      await initializeDatabase();
      console.log('✓ Database initialized');

      // Get user's GitHub token
      console.log(`📋 Fetching GitHub info for Slack user ${event.user}...`);
      const userInfo = await getUserInfo(event.user);

      if (!userInfo) {
        const appName = process.env.APP_NAME || 'lgtm';
        console.log(`❌ User ${event.user} has not connected their GitHub account`);
        console.log('📤 Sending connection instructions via DM...');
        await sendDM(
          event.user,
          `⚠️ You need to connect your GitHub account first! Use \`/${appName} connect\` to link your account.`,
          botToken
        );
        console.log('✓ DM sent');
        console.log('=== REACTION FLOW COMPLETE (no GitHub account) ===\n');
        return;
      }

      console.log(`✓ Found GitHub account: @${userInfo.username}`);

      // Fetch the message that was reacted to
      console.log(`📥 Fetching message content (channel: ${event.item.channel}, ts: ${event.item.ts})...`);
      const messageText = await getMessage(
        event.item.channel,
        event.item.ts,
        botToken
      );

      if (!messageText) {
        console.log('❌ Could not fetch message text');
        console.log('=== REACTION FLOW COMPLETE (no message) ===\n');
        return;
      }

      console.log(`✓ Message fetched: "${messageText.substring(0, 100)}${messageText.length > 100 ? '...' : ''}"`);

      // Extract all PR information from the message
      console.log('🔍 Extracting PR links from message...');
      const prs = extractPRs(messageText);

      if (prs.length === 0) {
        console.log('❌ No PR links found in message');
        console.log(`Message text: ${messageText}`);
        console.log('=== REACTION FLOW COMPLETE (no PRs) ===\n');
        return;
      }

      const prSummary = prs.map(pr => `${pr.owner}/${pr.repo}#${pr.prNumber}`).join(', ');
      console.log(`✓ Found ${prs.length} PR(s): ${prSummary}`);
      console.log(`🚀 Starting approval process as ${userInfo.username}...`);

      // Approve all PRs using the user's token
      const octokit = new Octokit({ auth: userInfo.token });

      const approvalResults = [];
      let prCount = 0;
      for (const pr of prs) {
        prCount++;
        console.log(`\n[PR ${prCount}/${prs.length}] Processing ${pr.owner}/${pr.repo}#${pr.prNumber}`);
        try {
          // Check if user has already approved this PR
          console.log('🔍 Checking existing approvals...');
          const alreadyApproved = await hasAlreadyApproved(
            octokit,
            pr.owner,
            pr.repo,
            pr.prNumber,
            userInfo.username
          );

          if (alreadyApproved) {
            console.log(`⏭️ Already approved by ${userInfo.username}, skipping`);
            approvalResults.push({ pr, status: 'skipped' });
            continue;
          }

          console.log('✓ Not yet approved, creating approval review...');
          await octokit.pulls.createReview({
            owner: pr.owner,
            repo: pr.repo,
            pull_number: pr.prNumber,
            event: 'APPROVE',
          });

          console.log(`✅ Successfully approved by ${userInfo.username} (Slack user: ${event.user})`);
          approvalResults.push({ pr, status: 'success' });
        } catch (prError: any) {
          console.error(`❌ Failed to approve: ${prError.message}`);
          approvalResults.push({ pr, status: 'failed', error: prError.message });
        }
      }

      // Log summary
      const successCount = approvalResults.filter(r => r.status === 'success').length;
      const skippedCount = approvalResults.filter(r => r.status === 'skipped').length;
      const failureCount = approvalResults.filter(r => r.status === 'failed').length;
      console.log(`\n📊 Approval summary: ${successCount} succeeded, ${skippedCount} skipped (already approved), ${failureCount} failed`);

      if (failureCount > 0) {
        const failed = approvalResults.filter(r => r.status === 'failed');
        console.log('Failed PRs:');
        failed.forEach(f => {
          console.log(`  - ${f.pr.owner}/${f.pr.repo}#${f.pr.prNumber}: ${f.error}`);
        });
      }

      console.log('=== REACTION FLOW COMPLETE ===\n');
      // Send success response
      return res.status(200).json({ ok: true });
    } catch (error: any) {
      console.error('❌ Failed to approve PR:', error.message);
      console.error('Error stack:', error.stack);

      // Try to notify the user of the error
      try {
        console.log('📤 Sending error notification via DM...');
        const appName = process.env.APP_NAME || 'lgtm';
        await sendDM(
          event.user,
          `❌ Failed to approve PR: ${error.message}. Your GitHub token might be invalid or expired. Try using \`/${appName} connect\` again.`,
          botToken
        );
        console.log('✓ Error DM sent');
      } catch (dmError) {
        console.error('❌ Failed to send error DM:', dmError);
      }

      console.log('=== REACTION FLOW COMPLETE (with error) ===\n');
      // Send response even on error
      return res.status(200).json({ ok: true });
    }
  }

  // Default response for other event types
  return res.status(200).json({ ok: true });
}
