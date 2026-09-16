const crypto = require('crypto');

/**
 * Verifies the `initData` string Telegram Mini Apps send to prove the
 * request really came from a logged-in Telegram user.
 * See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Returns { user, authDate } if the signature is valid, otherwise null.
 */
function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  const authDate = Number(params.get('auth_date')) * 1000;
  const userJson = params.get('user');
  const user = userJson ? JSON.parse(userJson) : null;
  if (!user) return null;

  return { user, authDate };
}

module.exports = { verifyInitData };
