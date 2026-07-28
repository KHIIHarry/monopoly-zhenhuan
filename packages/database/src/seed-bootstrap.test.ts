import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  existingAccount: null as {
    username: string;
    status: 'ACTIVE' | 'DISABLED';
    canCreateRoom: boolean;
  } | null,
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
}));

vi.mock('./index.js', () => ({
  prisma: {
    $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        propertyDefinition: { upsert: vi.fn() },
        character: { upsert: vi.fn() },
        account: {
          findUnique: vi.fn(async () => database.existingAccount),
          create: database.createAccount,
          update: database.updateAccount,
        },
      }),
    ),
    $disconnect: vi.fn(),
  },
}));

import { seed } from './seed.js';

const originalBootstrapEnvironment = {
  username: process.env.BOOTSTRAP_ADMIN_USERNAME,
  password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  displayName: process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME,
  superAdminUsernames: process.env.SUPER_ADMIN_USERNAMES,
};

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function runSeed(environment: Record<string, string | undefined>) {
  const names = [
    'BOOTSTRAP_ADMIN_USERNAME',
    'BOOTSTRAP_ADMIN_PASSWORD',
    'BOOTSTRAP_ADMIN_DISPLAY_NAME',
    'SUPER_ADMIN_USERNAMES',
  ];
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  try {
    for (const name of names) restoreEnvironment(name, environment[name]);
    return await seed();
  } finally {
    for (const name of names) restoreEnvironment(name, original[name]);
  }
}

describe('bootstrap administrator seed behavior', () => {
  beforeEach(() => {
    database.existingAccount = null;
    database.createAccount.mockReset();
    database.updateAccount.mockReset();
    process.env.BOOTSTRAP_ADMIN_USERNAME = 'bootstrap-admin';
    process.env.BOOTSTRAP_ADMIN_PASSWORD = 'a-secure-bootstrap-password';
    process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME = 'Bootstrap Admin';
    process.env.SUPER_ADMIN_USERNAMES = 'bootstrap-admin';
  });

  afterAll(() => {
    restoreEnvironment('BOOTSTRAP_ADMIN_USERNAME', originalBootstrapEnvironment.username);
    restoreEnvironment('BOOTSTRAP_ADMIN_PASSWORD', originalBootstrapEnvironment.password);
    restoreEnvironment('BOOTSTRAP_ADMIN_DISPLAY_NAME', originalBootstrapEnvironment.displayName);
    restoreEnvironment('SUPER_ADMIN_USERNAMES', originalBootstrapEnvironment.superAdminUsernames);
  });

  it('is idempotent for the existing enabled configured bootstrap administrator', async () => {
    database.existingAccount = {
      username: 'bootstrap-admin',
      status: 'ACTIVE',
      canCreateRoom: true,
    };

    await expect(seed()).resolves.toMatchObject({ bootstrapAdmin: true });
    expect(database.createAccount).not.toHaveBeenCalled();
    expect(database.updateAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['ordinary account', { status: 'ACTIVE', canCreateRoom: false }],
    ['disabled account', { status: 'DISABLED', canCreateRoom: true }],
  ] as const)('rejects a configured username owned by an %s', async (_label, privileges) => {
    database.existingAccount = { username: 'bootstrap-admin', ...privileges };

    await expect(seed()).rejects.toThrow('BOOTSTRAP_ADMIN_USERNAME_CONFLICT');
    expect(database.createAccount).not.toHaveBeenCalled();
    expect(database.updateAccount).not.toHaveBeenCalled();
    expect(database.existingAccount).toMatchObject(privileges);
  });

  it('rejects a bootstrap administrator not listed in SUPER_ADMIN_USERNAMES', async () => {
    await expect(runSeed({
      BOOTSTRAP_ADMIN_USERNAME: 'admin',
      BOOTSTRAP_ADMIN_PASSWORD: 'strong-password-value',
      BOOTSTRAP_ADMIN_DISPLAY_NAME: '管理员',
      SUPER_ADMIN_USERNAMES: 'owner',
    })).rejects.toThrow('BOOTSTRAP_ADMIN_USERNAME_NOT_CONFIGURED');
  });

  it.each([
    [undefined, 'SUPER_ADMIN_USERNAMES is required'],
    ['   ', 'SUPER_ADMIN_USERNAMES is required'],
    ['admin,,owner', 'SUPER_ADMIN_USERNAMES must not contain empty usernames'],
    ['admin,admin', 'SUPER_ADMIN_USERNAMES must not contain duplicate usernames'],
  ])('rejects invalid SUPER_ADMIN_USERNAMES: %s', async (superAdminUsernames, error) => {
    await expect(runSeed({
      BOOTSTRAP_ADMIN_USERNAME: undefined,
      BOOTSTRAP_ADMIN_PASSWORD: undefined,
      BOOTSTRAP_ADMIN_DISPLAY_NAME: undefined,
      SUPER_ADMIN_USERNAMES: superAdminUsernames,
    })).rejects.toThrow(error);
  });

  it('does not require a bootstrap account when bootstrap variables are absent', async () => {
    await expect(runSeed({
      BOOTSTRAP_ADMIN_USERNAME: undefined,
      BOOTSTRAP_ADMIN_PASSWORD: undefined,
      BOOTSTRAP_ADMIN_DISPLAY_NAME: undefined,
      SUPER_ADMIN_USERNAMES: 'admin',
    })).resolves.toMatchObject({ bootstrapAdmin: false });

    expect(database.createAccount).not.toHaveBeenCalled();
  });

  it('does not persist a super-administrator account property', async () => {
    await seed();

    expect(database.createAccount).toHaveBeenCalledWith({ data: expect.not.objectContaining({
      isSuperAdmin: expect.anything(),
    }) });
  });
});
