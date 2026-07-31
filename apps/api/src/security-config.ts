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
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  return { superAdminUsernames: loadSuperAdminUsernames(environment) };
}
