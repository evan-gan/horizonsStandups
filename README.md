# Standups Bot

Posts a daily standup message to a Slack channel and replies in the thread for updates.

<details>
<summary>Bot setup instructions</summary>

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** > **From an app manifest**
2. Select your workspace
3. Paste the contents of `manifest.yaml` and create the app
4. Go to **OAuth & Permissions** > **Install to Workspace** and authorize
5. Copy the **Bot User OAuth Token** (`xoxb-...`) for your `.env`
6. If posting to a private channel, invite the bot: `/invite @Standup Bot`

</details>

## Development Setup

```bash
# Install dependencies
pnpm install

# Copy the example env and fill in your values
cp .env.example .env

# Run the bot
pnpm start

# Run in dev mode (auto-restart on changes)
pnpm dev

# Run tests
pnpm test
```
