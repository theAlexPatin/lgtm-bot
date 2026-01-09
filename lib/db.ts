import { sql } from '@vercel/postgres';

export interface UserToken {
  slack_user_id: string;
  github_token: string;
  github_username: string;
  created_at: Date;
  updated_at: Date;
}

// Initialize database table
export async function initializeDatabase() {
  try {
    console.log('Creating table if not exists...');
    await sql`
      CREATE TABLE IF NOT EXISTS user_tokens (
        slack_user_id VARCHAR(255) PRIMARY KEY,
        github_token TEXT NOT NULL,
        github_username VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;
    console.log('Database table ready');
  } catch (error: any) {
    console.error('Failed to initialize database:', error.message);
    throw error;
  }
}

// Store or update user's GitHub token
export async function storeUserToken(
  slackUserId: string,
  githubToken: string,
  githubUsername: string
): Promise<void> {
  try {
    console.log(`Storing token for ${slackUserId}...`);
    await sql`
      INSERT INTO user_tokens (slack_user_id, github_token, github_username, updated_at)
      VALUES (${slackUserId}, ${githubToken}, ${githubUsername}, CURRENT_TIMESTAMP)
      ON CONFLICT (slack_user_id)
      DO UPDATE SET
        github_token = ${githubToken},
        github_username = ${githubUsername},
        updated_at = CURRENT_TIMESTAMP
    `;
    console.log(`Token stored for ${slackUserId}`);
  } catch (error: any) {
    console.error('Failed to store user token:', error.message);
    throw error;
  }
}

// Get user's GitHub token
export async function getUserToken(slackUserId: string): Promise<string | null> {
  try {
    const result = await sql`
      SELECT github_token
      FROM user_tokens
      WHERE slack_user_id = ${slackUserId}
    `;

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0].github_token;
  } catch (error: any) {
    console.error('Failed to get user token:', error.message);
    return null;
  }
}

// Get user's GitHub username
export async function getUserInfo(slackUserId: string): Promise<{ token: string; username: string } | null> {
  try {
    const result = await sql`
      SELECT github_token, github_username
      FROM user_tokens
      WHERE slack_user_id = ${slackUserId}
    `;

    if (result.rows.length === 0) {
      return null;
    }

    return {
      token: result.rows[0].github_token,
      username: result.rows[0].github_username
    };
  } catch (error: any) {
    console.error('Failed to get user info:', error.message);
    return null;
  }
}

// Delete user's token (for disconnecting)
export async function deleteUserToken(slackUserId: string): Promise<void> {
  try {
    await sql`
      DELETE FROM user_tokens
      WHERE slack_user_id = ${slackUserId}
    `;
  } catch (error: any) {
    console.error('Failed to delete user token:', error.message);
    throw error;
  }
}
