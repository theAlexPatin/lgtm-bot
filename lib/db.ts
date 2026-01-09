import { Pool } from 'pg';

export interface UserToken {
  slack_user_id: string;
  github_token: string;
  github_username: string;
  created_at: Date;
  updated_at: Date;
}

// Create a connection pool
let pool: Pool | null = null;

const getPool = () => {
  if (!pool) {
    const connectionString =
      process.env.POSTGRES_PRISMA_URL ||
      process.env.POSTGRES_URL ||
      process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error('No database connection string found. Please set POSTGRES_PRISMA_URL, POSTGRES_URL, or DATABASE_URL.');
    }

    pool = new Pool({
      connectionString,
      ssl: {
        rejectUnauthorized: false
      }
    });
  }
  return pool;
};

// Initialize database table
export async function initializeDatabase() {
  const client = await getPool().connect();
  try {
    console.log('Creating table if not exists...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        slack_user_id VARCHAR(255) PRIMARY KEY,
        github_token TEXT NOT NULL,
        github_username VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Database table ready');
  } catch (error: any) {
    console.error('Failed to initialize database:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

// Store or update user's GitHub token
export async function storeUserToken(
  slackUserId: string,
  githubToken: string,
  githubUsername: string
): Promise<void> {
  const client = await getPool().connect();
  try {
    console.log(`Storing token for ${slackUserId}...`);
    await client.query(
      `INSERT INTO user_tokens (slack_user_id, github_token, github_username, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (slack_user_id)
       DO UPDATE SET
         github_token = $2,
         github_username = $3,
         updated_at = CURRENT_TIMESTAMP`,
      [slackUserId, githubToken, githubUsername]
    );
    console.log(`Token stored for ${slackUserId}`);
  } catch (error: any) {
    console.error('Failed to store user token:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

// Get user's GitHub token
export async function getUserToken(slackUserId: string): Promise<string | null> {
  const client = await getPool().connect();
  try {
    const result = await client.query(
      'SELECT github_token FROM user_tokens WHERE slack_user_id = $1',
      [slackUserId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0].github_token;
  } catch (error: any) {
    console.error('Failed to get user token:', error.message);
    return null;
  } finally {
    client.release();
  }
}

// Get user's GitHub username
export async function getUserInfo(slackUserId: string): Promise<{ token: string; username: string } | null> {
  const client = await getPool().connect();
  try {
    const result = await client.query(
      'SELECT github_token, github_username FROM user_tokens WHERE slack_user_id = $1',
      [slackUserId]
    );

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
  } finally {
    client.release();
  }
}

// Delete user's token (for disconnecting)
export async function deleteUserToken(slackUserId: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(
      'DELETE FROM user_tokens WHERE slack_user_id = $1',
      [slackUserId]
    );
  } catch (error: any) {
    console.error('Failed to delete user token:', error.message);
    throw error;
  } finally {
    client.release();
  }
}
