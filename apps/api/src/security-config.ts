const localAdminToken = 'local-admin-change-me';
const localBankJoinToken = 'local-bank-change-me';
const minimumProductionTokenLength = 32;

type SecurityEnvironment = Record<string, string | undefined>;

export function loadSuperAdminUsernames(environment: SecurityEnvironment = process.env) {
  const configuredUsernames = environment.SUPER_ADMIN_USERNAMES;
  if (!configuredUsernames?.trim()) {
    throw new Error('SUPER_ADMIN_USERNAMES is required');
  }

  const usernames = configuredUsernames.split(',').map((username) => username.trim());
  if (usernames.some((username) => !username)) {
    throw new Error('SUPER_ADMIN_USERNAMES must not contain empty usernames');
  }

  const superAdminUsernames = new Set(usernames);
  if (superAdminUsernames.size !== usernames.length) {
    throw new Error('SUPER_ADMIN_USERNAMES must not contain duplicate usernames');
  }

  return superAdminUsernames;
}

export function loadSecurityConfig(environment: SecurityEnvironment = process.env) {
  const nodeEnv = environment.NODE_ENV;
  const adminToken = environment.ADMIN_TOKEN ?? localAdminToken;
  const bankJoinToken = environment.BANK_JOIN_TOKEN ?? localBankJoinToken;
  const superAdminUsernames = loadSuperAdminUsernames(environment);

  if (nodeEnv === 'development' || nodeEnv === 'test') {
    return { adminToken, bankJoinToken, superAdminUsernames };
  }
  if (nodeEnv !== 'production') throw new Error('NODE_ENV must be development, test, or production');

  if (!environment.ADMIN_TOKEN || !environment.BANK_JOIN_TOKEN) {
    throw new Error('ADMIN_TOKEN and BANK_JOIN_TOKEN are required in production');
  }
  if (adminToken === localAdminToken) {
    throw new Error('ADMIN_TOKEN must not use the local default in production');
  }
  if (bankJoinToken === localBankJoinToken) {
    throw new Error('BANK_JOIN_TOKEN must not use the local default in production');
  }
  if (adminToken === bankJoinToken) {
    throw new Error('ADMIN_TOKEN and BANK_JOIN_TOKEN must differ in production');
  }
  if (adminToken.length < minimumProductionTokenLength) {
    throw new Error(`ADMIN_TOKEN must be at least ${minimumProductionTokenLength} characters in production`);
  }
  if (bankJoinToken.length < minimumProductionTokenLength) {
    throw new Error(`BANK_JOIN_TOKEN must be at least ${minimumProductionTokenLength} characters in production`);
  }

  return { adminToken, bankJoinToken, superAdminUsernames };
}
