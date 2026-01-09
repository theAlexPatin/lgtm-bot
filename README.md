# LGTM Bot

A Slack bot that automatically approves GitHub pull requests when you react with ✅ to messages containing PR links. Each approval is made using the reacting user's own GitHub account.

## Features

- React with ✅ to any message with a PR link to approve it
- Each user approves with their own GitHub account (OAuth)
- Supports both GitHub and Graphite PR links
- Channel restrictions for safety
- Secure request verification with Slack signing secret
- User token storage with Vercel Postgres
- Deployed on Vercel for serverless execution
- TypeScript for type safety

## How It Works

1. Connect your GitHub account using `/<app_name> connect` command (one-time setup)
2. When someone posts a PR link in a monitored Slack channel
3. React with ✅ emoji
4. The bot approves the PR on GitHub using **your** GitHub account

**Note**: Replace `<app_name>` with your configured `APP_NAME` (default: `lgtm`). So the command would be `/lgtm connect` by default.

Supported link formats:
- GitHub: `https://github.com/owner/repo/pull/123`
- Graphite: `https://app.graphite.dev/github/pr/owner/repo/123`

## Setup

### 1. Install Dependencies

```bash
yarn install
```

### 2. Create GitHub OAuth App

1. Go to [GitHub Settings > Developer settings > OAuth Apps](https://github.com/settings/developers)
2. Click "New OAuth App"
3. Fill in the details:
   - **Application name**: LGTM Bot
   - **Homepage URL**: `https://your-app.vercel.app` (you'll update this after deploying)
   - **Authorization callback URL**: `https://your-app.vercel.app/api/oauth/callback`
4. Click "Register application"
5. Copy the **Client ID**
6. Click "Generate a new client secret" and copy the **Client Secret**

**Important**: Each user will need the `repo` scope to approve PRs.

### 3. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click "Create New App"
2. Choose "From scratch"
3. Give it a name like "LGTM Bot" and select your workspace

#### Configure OAuth & Permissions

4. Go to "OAuth & Permissions" in the sidebar
5. Scroll down to "Scopes" and add these Bot Token Scopes:
   - `reactions:read` (to see when reactions are added)
   - `channels:history` (to read message content in public channels)
   - `groups:history` (to read message content in private channels)
   - `chat:write` (to send DM notifications)
   - `im:write` (to open DMs with users)
   - `commands` (to handle the /connect command)
6. Click "Install to Workspace" at the top and authorize the app
7. Copy the "Bot User OAuth Token" (starts with `xoxb-`)

#### Create Slash Command

8. Go to "Slash Commands" in the sidebar
9. Click "Create New Command"
10. Set the following:
    - Command: `/<your-app-name> connect` (e.g., `/lgtm connect`)
    - Request URL: `https://your-vercel-app.vercel.app/api/connect` (update after deploying)
    - Short Description: "Connect your GitHub account"
11. Save the command

**Note**: The command name should match your `APP_NAME` environment variable. For example, if you set `APP_NAME=lgtm`, create the command as `/lgtm connect`.

#### Enable Event Subscriptions

12. Go to "Event Subscriptions" in the sidebar
13. Toggle "Enable Events" to On
14. Set Request URL to: `https://your-vercel-app.vercel.app/api/events`
    - You'll need to deploy first and then come back to set this
    - Slack will verify the URL before saving
15. Under "Subscribe to bot events", add:
    - `reaction_added`
16. Save changes

#### Get Your Slack Signing Secret

17. Go to "Basic Information"
18. Scroll down to "App Credentials"
19. Copy the "Signing Secret"

### 4. Get Channel IDs

To restrict the bot to specific channels:

1. Open Slack in your browser
2. Navigate to the channel you want to monitor
3. The URL will look like: `https://yourworkspace.slack.com/messages/C01234567`
4. Copy the channel ID (the part after `/messages/`, e.g., `C01234567`)
5. Repeat for all channels you want to monitor

### 5. Set Up Vercel Postgres

1. Install Vercel CLI if you haven't:
   ```bash
   npm install -g vercel
   ```

2. Deploy the app first (to create the project):
   ```bash
   vercel
   ```

3. Go to your [Vercel Dashboard](https://vercel.com/dashboard)
4. Select your project
5. Go to the "Storage" tab
6. Click "Create Database" > "Postgres"
7. Follow the prompts to create a Postgres database
8. The database environment variables will be automatically added to your project

### 6. Configure Environment Variables

Add these environment variables to your Vercel project:

```bash
vercel env add SLACK_SIGNING_SECRET
vercel env add SLACK_BOT_TOKEN
vercel env add SLACK_ALLOWED_CHANNELS
vercel env add TRIGGER_EMOJI
vercel env add APP_NAME
vercel env add GITHUB_CLIENT_ID
vercel env add GITHUB_CLIENT_SECRET
vercel env add GITHUB_OWNER
vercel env add GITHUB_REPO
vercel env add BASE_URL
```

Example values:

```env
SLACK_SIGNING_SECRET=abc123...
SLACK_BOT_TOKEN=xoxb-...
SLACK_ALLOWED_CHANNELS=C01234567,C07654321
TRIGGER_EMOJI=white_check_mark
APP_NAME=lgtm
GITHUB_CLIENT_ID=Iv1.abc123...
GITHUB_CLIENT_SECRET=abc123...
GITHUB_OWNER=your-company
GITHUB_REPO=your-repo
BASE_URL=your-app.vercel.app
```

**Notes:**
- `SLACK_ALLOWED_CHANNELS`: Comma-separated list of channel IDs (no spaces)
- `TRIGGER_EMOJI`: The emoji name without colons (default: `white_check_mark` for ✅)
- `APP_NAME`: Name used for the slash command (e.g., `lgtm` for `/lgtm connect`)
- `BASE_URL`: Your Vercel app domain without `https://`

### 7. Deploy to Production

```bash
vercel --prod
```

### 8. Update Slack URLs

Now that you have your production URL:

1. Go back to your Slack app settings
2. Update "Slash Commands" > `/<your-app-name> connect` > Request URL to: `https://your-app.vercel.app/api/connect`
3. Update "Event Subscriptions" > Request URL to: `https://your-app.vercel.app/api/events`
4. Slack will verify both URLs (should show green checkmarks)
5. Save changes

### 9. Update GitHub OAuth App

1. Go back to your GitHub OAuth App settings
2. Update the Homepage URL and Authorization callback URL with your production Vercel URL
3. Save changes

### 10. Add Bot to Channels

1. In Slack, go to each channel you want to monitor
2. Type `/invite @LGTM Bot` (or whatever you named your bot)
3. The bot needs to be in the channel to receive events

## Usage

### First Time Setup (Per User)

Each user needs to connect their GitHub account once:

1. In any Slack channel or DM, type: `/<app_name> connect` (e.g., `/lgtm connect`)
2. Click the "Connect GitHub Account" button
3. Authorize the app on GitHub
4. You'll see a success message

### Approving PRs

1. Someone posts a message containing a PR link:
   ```
   Please review: https://github.com/mycompany/myrepo/pull/123
   ```
   or
   ```
   Check out this PR: https://app.graphite.dev/github/pr/mycompany/myrepo/456
   ```

2. React to the message with ✅

3. The bot will automatically approve the PR on GitHub using your connected account

**Note**: If you haven't connected your GitHub account, the bot will DM you a reminder to use `/<app_name> connect`.

## Development

Run locally with:

```bash
yarn dev
```

For local testing with Slack, you'll need to use a tool like [ngrok](https://ngrok.com/) to expose your local server:

```bash
ngrok http 3000
```

Then update your Slack slash command and event subscription URLs to the ngrok URL.

For local development, you'll also need to set up a local Postgres database or use Vercel's development environment:

```bash
vercel dev
```

## Security Notes

- The bot verifies all requests are from Slack using signature verification
- Each user's GitHub token is stored securely in Vercel Postgres
- Tokens are encrypted at rest by Vercel
- Each approval uses the reacting user's own GitHub account
- Never commit `.env` file or expose your secrets
- Requests older than 5 minutes are rejected to prevent replay attacks
- Use `SLACK_ALLOWED_CHANNELS` to restrict which channels the bot monitors

## Troubleshooting

### Bot doesn't respond to reactions
- Make sure the bot is invited to the channel (`/invite @LGTM Bot`)
- Verify the channel ID is in `SLACK_ALLOWED_CHANNELS`
- Check that you're using the correct emoji (default: ✅)
- Ensure you've connected your GitHub account with `/<app_name> connect`
- Check Vercel function logs: `vercel logs`

### "You need to connect your GitHub account" message
- Run `/<app_name> connect` in Slack (e.g., `/lgtm connect`)
- Click the button and authorize the app on GitHub
- Make sure you complete the OAuth flow

### "Invalid signature" error
- Verify your `SLACK_SIGNING_SECRET` is correct
- Make sure Vercel is receiving the raw request body

### GitHub approval fails
- Your GitHub token might be expired or revoked
- Try reconnecting with `/<app_name> connect`
- Verify the PR exists and is open
- Ensure you have permission to approve PRs in the repository
- Check Vercel function logs: `vercel logs`

### Event subscription verification fails
- Make sure your Vercel function is deployed and accessible
- The endpoint must respond to the URL verification challenge
- Check that your signing secret is correct
- Ensure Vercel Postgres is set up and connected

### No PR found in message
- Make sure the message contains a valid GitHub or Graphite PR URL
- URLs must be in the format shown in the "How It Works" section

### Database connection errors
- Ensure you've created a Vercel Postgres database in your project
- Check that the database environment variables are set
- Try redeploying: `vercel --prod`

## Customization

### Change the trigger emoji

Edit `TRIGGER_EMOJI` in your Vercel environment variables:

- For `:thumbsup:` use: `+1`
- For `:rocket:` use: `rocket`
- For `:white_check_mark:` use: `white_check_mark` (default)

### Allow all channels

Leave `SLACK_ALLOWED_CHANNELS` empty to monitor all channels the bot is invited to:

```env
SLACK_ALLOWED_CHANNELS=
```

**Warning:** This is not recommended as it could lead to accidental PR approvals.

## Architecture

```
┌─────────────┐
│   Slack     │
│   User      │
└──────┬──────┘
       │
       │ 1. /connect command
       ▼
┌─────────────────────┐
│  Slack App          │
│  /api/connect       │
└──────┬──────────────┘
       │
       │ 2. GitHub OAuth URL
       ▼
┌─────────────────────┐
│  GitHub OAuth       │
│  Authorize          │
└──────┬──────────────┘
       │
       │ 3. Callback with code
       ▼
┌─────────────────────┐      ┌────────────────┐
│ /api/oauth/callback │─────▶│ Vercel Postgres│
│ Store user token    │      │ user_tokens    │
└─────────────────────┘      └────────────────┘

┌─────────────┐
│   Slack     │
│   User      │
└──────┬──────┘
       │
       │ 4. React with ✅
       ▼
┌─────────────────────┐      ┌────────────────┐
│  /api/events        │─────▶│ Vercel Postgres│
│  reaction_added     │◀─────│ Get user token │
└──────┬──────────────┘      └────────────────┘
       │
       │ 5. Approve PR with user's token
       ▼
┌─────────────────────┐
│  GitHub API         │
│  Create Review      │
└─────────────────────┘
```

## License

MIT
