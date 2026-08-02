import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';
import { loadMasterData } from '@zhenhuan/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountRoomService, type AuthenticatedSession, type RequestContext } from './account-room-service.js';
import { hashPassword } from './auth-domain.js';
import { PrismaGameService } from './prisma-game-service.js';

const accountPrefix = 'task2-auth-';

function configuredTestDatabaseUrl() {
  const rawUrl = process.env.TEST_DATABASE_URL;
  if (!rawUrl) return undefined;

  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('TEST_DATABASE_URL must be a PostgreSQL URL');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!databaseName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL database name must end in _test');
  }
  if (process.env.DATABASE_URL) {
    const application = new URL(process.env.DATABASE_URL);
    const testIdentity = `${parsed.hostname.toLowerCase()}:${parsed.port || '5432'}/${databaseName}`;
    const applicationName = decodeURIComponent(application.pathname.replace(/^\/+/, ''));
    const applicationIdentity = `${application.hostname.toLowerCase()}:${application.port || '5432'}/${applicationName}`;
    if (testIdentity === applicationIdentity) {
      throw new Error('TEST_DATABASE_URL must not resolve to the same database as DATABASE_URL');
    }
  }
  return rawUrl;
}

const testDatabaseUrl = configuredTestDatabaseUrl();
const integration = describe.skipIf(!testDatabaseUrl);
const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const migrationRoot = fileURLToPath(new URL('../../../packages/database/prisma/migrations/', import.meta.url));
const prismaCli = fileURLToPath(new URL('../../../node_modules/prisma/build/index.js', import.meta.url));
const masterDataSource = new URL('../../../甄嬛传大富翁_master-data.json', import.meta.url);
const isolatedSchemaName = `account_room_${process.pid}_${randomUUID().replaceAll('-', '')}`;
let isolatedTestDatabaseUrl: string | undefined;
let isolatedSchemaCreated = false;

function executeSql(databaseUrl: string, sql: string) {
  try {
    execFileSync(process.execPath, [prismaCli, 'db', 'execute', '--stdin', '--url', databaseUrl], {
      cwd: workspaceRoot,
      input: sql,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    const execution = error as { stdout?: string; stderr?: string };
    throw new Error([execution.stdout, execution.stderr].filter(Boolean).join('\n') || String(error), { cause: error });
  }
}

function executeMigration(databaseUrl: string, directory: string) {
  try {
    execFileSync(process.execPath, [
      prismaCli,
      'db',
      'execute',
      '--file',
      `${migrationRoot}${directory}/migration.sql`,
      '--url',
      databaseUrl,
    ], { cwd: workspaceRoot, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const execution = error as { stdout?: string; stderr?: string };
    throw new Error([execution.stdout, execution.stderr].filter(Boolean).join('\n') || String(error), { cause: error });
  }
}

async function seedMasterData(databaseUrl: string) {
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const data = loadMasterData(JSON.parse(await readFile(masterDataSource, 'utf8')) as unknown);
  try {
    await db.$transaction(async (tx) => {
      for (const [index, property] of data.properties.entries()) {
        await tx.propertyDefinition.create({ data: {
          name: property.name,
          displayOrder: index + 1,
          mortgagePrice: property.mortgage,
          purchasePrice: property.purchasePrice,
          buildCost: property.build,
          buildingSellPrice: property.buildingSell,
          tollEmpty: property.tolls[0]!,
          tollLevel1: property.tolls[1]!,
          tollLevel2: property.tolls[2]!,
          tollLevel3: property.tolls[3]!,
          tollLevel4: property.tolls[4]!,
          tollPalace: property.tolls[5]!,
        } });
      }
      for (const character of data.characters) {
        await tx.character.create({ data: {
          id: character.id,
          name: character.name,
          skillCode: character.skill.code,
          skillConfig: character.skill.config,
          initialProperty: { connect: { name: character.initialProperty } },
        } });
      }
    });
  } finally {
    await db.$disconnect();
  }
}

beforeAll(async () => {
  if (!testDatabaseUrl) return;
  const isolatedUrl = new URL(testDatabaseUrl);
  isolatedUrl.searchParams.set('schema', isolatedSchemaName);
  isolatedTestDatabaseUrl = isolatedUrl.toString();
  executeSql(testDatabaseUrl, `CREATE SCHEMA "${isolatedSchemaName}";`);
  isolatedSchemaCreated = true;
  const migrations = readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const migration of migrations) executeMigration(isolatedTestDatabaseUrl, migration);
  await seedMasterData(isolatedTestDatabaseUrl);
}, 120_000);

afterAll(() => {
  if (testDatabaseUrl && isolatedSchemaCreated) {
    executeSql(testDatabaseUrl, `DROP SCHEMA "${isolatedSchemaName}" CASCADE;`);
  }
});

const contexts = {
  iphone: { ip: '120.31.22.36', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' },
  windows: { ip: '10.24.18.99', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36' },
  android: { ip: '172.20.8.44', userAgent: 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36' },
} satisfies Record<string, RequestContext>;

function expectNoSessionIds(value: unknown, sessionIds: string[]) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toMatch(/activeSessionId|previousSessionId|revokedSessionId|newSessionId|sessionId/);
  for (const sessionId of sessionIds) expect(serialized).not.toContain(sessionId);
}

integration('AccountRoomService PostgreSQL authentication', () => {
  let db: PrismaClient;
  let service: AccountRoomService;
  const configuredSuperAdmins = new Set<string>();

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: isolatedTestDatabaseUrl! } } });
    service = new AccountRoomService(db, (username) => configuredSuperAdmins.has(username));
    await db.$queryRaw`SELECT 1`;
  });

  afterAll(async () => { await db?.$disconnect(); });

  async function createAccount(options: { superAdmin?: boolean; canCreateRoom?: boolean } = {}) {
    const suffix = randomUUID();
    const password = `Password-${suffix}`;
    const username = `${accountPrefix}${suffix}`;
    if (options.superAdmin) configuredSuperAdmins.add(username);
    const account = await db.account.create({
      data: {
        username,
        passwordHash: await hashPassword(password),
        displayName: `Task 2 ${suffix.slice(0, 8)}`,
        canCreateRoom: options.canCreateRoom ?? false,
      },
    });
    return { account, password };
  }

  function publicSessionKeys() {
    return [
      'browser', 'createdAt', 'current', 'deviceName', 'id', 'lastActiveAt',
      'lastIp', 'loginIp', 'operatingSystem',
    ];
  }

  function expectNoSecrets(value: unknown) {
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('sessionTokenHash');
    expect(serialized).not.toContain('rawToken');
  }

  it('returns an allowlisted room creation response without its stored password hash', async () => {
    const creator = await createAccount({ canCreateRoom: true });
    const auth: AuthenticatedSession = {
      account: {
        id: creator.account.id,
        username: creator.account.username,
        displayName: creator.account.displayName,
        isSuperAdmin: false,
        canCreateRoom: true,
      },
      session: { id: 'task-2-room-session', accountId: creator.account.id },
    };

    const created = await service.createRoom(auth, {
      name: 'Task 2 protected room',
      password: 'room-password',
      initialBalance: 6_000,
      diceMode: 'PHYSICAL',
      skillEnabled: true,
      startReward: 1_200,
      allowMidgameJoin: false,
      visibility: 'PRIVATE',
      transferApprovalRequired: true,
    }, 'task-2-create-room');

    expect(Object.keys(created).sort()).toEqual([
      'allowMidgameJoin', 'code', 'createdAt', 'diceMode',
      'expiresAt', 'hasPassword', 'id', 'initialBalance', 'name', 'skillEnabled',
      'startReward', 'status', 'transferApprovalRequired', 'visibility',
    ]);
    expect(created).toMatchObject({
      name: 'Task 2 protected room',
      status: 'LOBBY',
      hasPassword: true,
      initialBalance: 6_000,
      diceMode: 'PHYSICAL',
      visibility: 'PRIVATE',
    });
    expect(JSON.stringify(created)).not.toContain('autoSkipTurn');
    expect(JSON.stringify(created)).not.toContain('passwordHash');
    const stored = await db.room.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.passwordHash).toMatch(/^scrypt\$/);
  });

  it('allows two devices and returns two sanitized summaries without creating a third Session', async () => {
    const { account, password } = await createAccount();

    const first = await service.login(account.username, password, contexts.iphone);
    const second = await service.login(account.username, password, contexts.windows);
    const third = await service.login(account.username, password, contexts.android);

    expect(first.status).toBe('OK');
    expect(second.status).toBe('OK');
    if (first.status !== 'OK' || second.status !== 'OK') throw new Error('login unexpectedly limited');
    expectNoSecrets({ status: first.status, account: first.account, session: first.session });
    expectNoSecrets({ status: second.status, account: second.account, session: second.session });
    const storedFirst = await db.accountSession.findUniqueOrThrow({ where: { id: first.session.id } });
    expect(storedFirst.sessionTokenHash).not.toBe(first.rawToken);
    expect(storedFirst.sessionTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(third.status).toBe('LIMIT');
    if (third.status !== 'LIMIT') throw new Error('expected session limit');
    expect(third.devices).toHaveLength(2);
    for (const device of third.devices) {
      expect(Object.keys(device).sort()).toEqual(publicSessionKeys());
      expectNoSecrets(device);
      expect(device.current).toBe(false);
    }
    expect(third.devices.map((device) => device.deviceName)).toEqual(['iOS Safari', 'Windows Chrome']);
    expect(third.devices[0]?.loginIp).toBe('120.***.***.36');
    expect(await db.accountSession.count({ where: { accountId: account.id, revokedAt: null } })).toBe(2);
  });

  it('atomically admits exactly two of three simultaneous logins', async () => {
    const { account, password } = await createAccount();
    const clients = [0, 1, 2].map(() => new PrismaClient({ datasources: { db: { url: isolatedTestDatabaseUrl! } } }));
    const services = clients.map((client) => new AccountRoomService(client));

    try {
      const results = await Promise.all([
        services[0]!.login(account.username, password, contexts.iphone),
        services[1]!.login(account.username, password, contexts.windows),
        services[2]!.login(account.username, password, contexts.android),
      ]);

      expect(results.filter((result) => result.status === 'OK')).toHaveLength(2);
      const limited = results.filter((result) => result.status === 'LIMIT');
      expect(limited).toHaveLength(1);
      if (limited[0]?.status !== 'LIMIT') throw new Error('expected one limited login');
      expect(limited[0].devices).toHaveLength(2);
      for (const device of limited[0].devices) {
        expect(Object.keys(device).sort()).toEqual(publicSessionKeys());
        expectNoSecrets(device);
      }
      expect(await db.accountSession.count({
        where: { accountId: account.id, revokedAt: null, expiresAt: { gt: new Date() } },
      })).toBe(2);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it('derives the device name server-side even if an internal caller supplies a deviceName property', async () => {
    const { account, password } = await createAccount();
    const context = { ...contexts.android, deviceName: 'User supplied device name' } as RequestContext;

    const login = await service.login(account.username, password, context);

    expect(login.status).toBe('OK');
    const stored = await db.accountSession.findFirstOrThrow({ where: { accountId: account.id } });
    expect(stored.deviceName).toBe('Android Chrome');
  });

  it('re-verifies the password and atomically replaces the oldest active Session', async () => {
    const { account, password } = await createAccount();
    const first = await service.login(account.username, password, contexts.iphone);
    if (first.status !== 'OK') throw new Error('first login unexpectedly limited');
    await db.accountSession.update({ where: { id: first.session.id }, data: { createdAt: new Date('2026-01-01T00:00:00.000Z') } });
    const second = await service.login(account.username, password, contexts.windows);
    if (second.status !== 'OK') throw new Error('second login unexpectedly limited');

    await expect(service.replaceOldestSession(account.username, 'incorrect-password', contexts.android))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(await db.accountSession.count({ where: { accountId: account.id, revokedAt: null } })).toBe(2);

    const replacement = await service.replaceOldestSession(account.username, password, contexts.android);
    const sessions = await db.accountSession.findMany({ where: { accountId: account.id }, orderBy: { createdAt: 'asc' } });

    expect(sessions).toHaveLength(3);
    expect(sessions.find((session) => session.id === first.session.id)).toMatchObject({ revokeReason: 'REPLACED_BY_NEW_DEVICE' });
    expect(sessions.find((session) => session.id === first.session.id)?.revokedAt).toBeInstanceOf(Date);
    expect(sessions.find((session) => session.id === second.session.id)?.revokedAt).toBeNull();
    expect(sessions.find((session) => session.id === replacement.session.id)?.revokedAt).toBeNull();
    await expect(service.authenticate(first.rawToken, contexts.iphone.ip)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    await expect(service.authenticate(replacement.rawToken, contexts.android.ip)).resolves.toMatchObject({
      account: { id: account.id },
      session: { id: replacement.session.id },
    });
    expect(await db.securityLog.count({ where: { accountId: account.id, action: 'REPLACED_OLDEST_SESSION' } })).toBe(1);
  });

  it('returns only safe account and Session fields while masking IPs and marking the current device', async () => {
    const { account, password } = await createAccount();
    const first = await service.login(account.username, password, contexts.iphone);
    const second = await service.login(account.username, password, contexts.windows);
    if (first.status !== 'OK' || second.status !== 'OK') throw new Error('login unexpectedly limited');

    const auth = await service.authenticate(first.rawToken, '120.31.55.36');
    const sessions = await service.listSessions(auth);

    expect(Object.keys(auth.account).sort()).toEqual(['canCreateRoom', 'displayName', 'id', 'isSuperAdmin', 'lastLoginAt', 'username']);
    expect(Object.keys(auth.session).sort()).toEqual(['accountId', 'id']);
    expectNoSecrets(auth.account);
    expectNoSecrets(auth.session);
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(Object.keys(session).sort()).toEqual(publicSessionKeys());
      expectNoSecrets(session);
    }
    expect(sessions.find((session) => session.id === first.session.id)).toMatchObject({
      current: true,
      loginIp: '120.***.***.36',
      lastIp: '120.***.***.36',
    });
    expect(sessions.find((session) => session.id === second.session.id)).toMatchObject({
      current: false,
      loginIp: '10.***.***.99',
      lastIp: '10.***.***.99',
    });
  });

  it('rejects revoked and expired Sessions', async () => {
    const { account, password } = await createAccount();
    const revoked = await service.login(account.username, password, contexts.iphone);
    const expired = await service.login(account.username, password, contexts.windows);
    if (revoked.status !== 'OK' || expired.status !== 'OK') throw new Error('login unexpectedly limited');
    const auth = await service.authenticate(revoked.rawToken, contexts.iphone.ip);

    await service.revokeSession(auth, revoked.session.id);
    await db.accountSession.update({ where: { id: expired.session.id }, data: { expiresAt: new Date(Date.now() - 1) } });

    await expect(service.authenticate(revoked.rawToken, contexts.iphone.ip)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    await expect(service.authenticate(expired.rawToken, contexts.windows.ip)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
  });

  it('password reset and account disable revoke every Session immediately', async () => {
    const administrator = await createAccount({ superAdmin: true });
    const adminLogin = await service.login(administrator.account.username, administrator.password, contexts.android);
    if (adminLogin.status !== 'OK') throw new Error('admin login unexpectedly limited');
    const admin = await service.authenticate(adminLogin.rawToken, contexts.android.ip);

    const resetTarget = await createAccount();
    const resetFirst = await service.login(resetTarget.account.username, resetTarget.password, contexts.iphone);
    const resetSecond = await service.login(resetTarget.account.username, resetTarget.password, contexts.windows);
    if (resetFirst.status !== 'OK' || resetSecond.status !== 'OK') throw new Error('login unexpectedly limited');
    await service.resetPassword(admin, resetTarget.account.id, 'New-Password-After-Reset', 'task6-reset-password');
    await expect(service.authenticate(resetFirst.rawToken, contexts.iphone.ip)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    await expect(service.authenticate(resetSecond.rawToken, contexts.windows.ip)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    expect(await db.accountSession.count({ where: { accountId: resetTarget.account.id, revokeReason: 'PASSWORD_RESET' } })).toBe(2);

    const disabledTarget = await createAccount();
    const disabledFirst = await service.login(disabledTarget.account.username, disabledTarget.password, contexts.iphone);
    const disabledSecond = await service.login(disabledTarget.account.username, disabledTarget.password, contexts.windows);
    if (disabledFirst.status !== 'OK' || disabledSecond.status !== 'OK') throw new Error('login unexpectedly limited');
    await service.setAccountStatus(admin, disabledTarget.account.id, false, 'task6-disable-account');
    await expect(service.authenticate(disabledFirst.rawToken, contexts.iphone.ip)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    await expect(service.authenticate(disabledSecond.rawToken, contexts.windows.ip)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    expect(await db.accountSession.count({ where: { accountId: disabledTarget.account.id, revokeReason: 'ACCOUNT_DISABLED' } })).toBe(2);
  });

  it('revokes a named Session, logs out other Sessions, and logs out the current Session', async () => {
    const namedTarget = await createAccount();
    const namedFirst = await service.login(namedTarget.account.username, namedTarget.password, contexts.iphone);
    const namedSecond = await service.login(namedTarget.account.username, namedTarget.password, contexts.windows);
    if (namedFirst.status !== 'OK' || namedSecond.status !== 'OK') throw new Error('login unexpectedly limited');
    const namedAuth = await service.authenticate(namedFirst.rawToken, contexts.iphone.ip);
    await service.revokeSession(namedAuth, namedSecond.session.id);
    await expect(service.authenticate(namedSecond.rawToken, contexts.windows.ip)).rejects.toMatchObject({ code: 'SESSION_INVALID' });

    const othersTarget = await createAccount();
    const othersFirst = await service.login(othersTarget.account.username, othersTarget.password, contexts.iphone);
    const othersSecond = await service.login(othersTarget.account.username, othersTarget.password, contexts.windows);
    if (othersFirst.status !== 'OK' || othersSecond.status !== 'OK') throw new Error('login unexpectedly limited');
    const othersAuth = await service.authenticate(othersFirst.rawToken, contexts.iphone.ip);
    await expect(service.revokeSession(namedAuth, othersSecond.session.id)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await expect(service.authenticate(othersSecond.rawToken, contexts.windows.ip)).resolves.toMatchObject({ session: { id: othersSecond.session.id } });
    await expect(service.logoutOthers(othersAuth)).resolves.toEqual({ revoked: 1, revokedSessionIds: [othersSecond.session.id] });
    await expect(service.authenticate(othersFirst.rawToken, contexts.iphone.ip)).resolves.toMatchObject({ session: { id: othersFirst.session.id } });
    await expect(service.authenticate(othersSecond.rawToken, contexts.windows.ip)).rejects.toMatchObject({ code: 'SESSION_INVALID' });

    await service.revokeSession(othersAuth, othersFirst.session.id);
    await expect(service.authenticate(othersFirst.rawToken, contexts.iphone.ip)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
  });

  it('writes login, replacement, and self-revoke SecurityLogs without raw Session identifiers', async () => {
    const { account, password } = await createAccount();
    const first = await service.login(account.username, password, contexts.iphone);
    const second = await service.login(account.username, password, contexts.windows);
    if (first.status !== 'OK' || second.status !== 'OK') throw new Error('login unexpectedly limited');
    await db.accountSession.update({ where: { id: first.session.id }, data: { createdAt: new Date('2026-01-01T00:00:00.000Z') } });
    const replacement = await service.replaceOldestSession(account.username, password, contexts.android);
    const auth = await service.authenticate(second.rawToken, contexts.windows.ip);
    await service.revokeSession(auth, replacement.session.id);

    const logs = await db.securityLog.findMany({
      where: { accountId: account.id, action: { in: ['LOGIN_SUCCEEDED', 'REPLACED_OLDEST_SESSION', 'SESSION_REVOKED'] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs.map((log) => log.action)).toEqual([
      'LOGIN_SUCCEEDED',
      'LOGIN_SUCCEEDED',
      'REPLACED_OLDEST_SESSION',
      'SESSION_REVOKED',
    ]);
    expectNoSessionIds(logs, [first.session.id, second.session.id, replacement.session.id]);
  });
});

integration('AccountRoomService PostgreSQL room lobby V2.1', () => {
  let db: PrismaClient;
  let service: AccountRoomService;
  const configuredSuperAdmins = new Set<string>();

  const roomInput = (name: string, overrides: Partial<{
    password: string;
    initialBalance: number;
    diceMode: 'ELECTRONIC' | 'PHYSICAL';
    skillEnabled: boolean;
    startReward: number;
    allowMidgameJoin: boolean;
    visibility: 'PUBLIC' | 'PRIVATE';
    transferApprovalRequired: boolean;
  }> = {}) => ({
    name,
    initialBalance: 6_000,
    diceMode: 'PHYSICAL' as const,
    skillEnabled: true,
    startReward: 1_000,
    allowMidgameJoin: false,
    visibility: 'PUBLIC' as const,
    transferApprovalRequired: false,
    ...overrides,
  });

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: isolatedTestDatabaseUrl! } } });
    service = new AccountRoomService(db, (username) => configuredSuperAdmins.has(username));
    await db.$queryRaw`SELECT 1`;
  });

  afterAll(async () => { await db?.$disconnect(); });

  async function createAuth(options: { canCreateRoom?: boolean; displayName?: string; superAdmin?: boolean } = {}) {
    const suffix = randomUUID();
    const username = `${accountPrefix}${suffix}`;
    if (options.superAdmin) configuredSuperAdmins.add(username);
    const account = await db.account.create({
      data: {
        username,
        passwordHash: await hashPassword(`Password-${suffix}`),
        displayName: options.displayName ?? `Task 3 ${suffix.slice(0, 8)}`,
        canCreateRoom: options.canCreateRoom ?? false,
      },
    });
    const session = await db.accountSession.create({
      data: {
        accountId: account.id,
        sessionTokenHash: randomUUID().replaceAll('-', ''),
        deviceId: randomUUID(),
        deviceName: 'Test Browser',
        browser: 'Test',
        operatingSystem: 'Test',
        userAgent: 'Task 3 integration test',
        loginIp: '127.0.0.1',
        lastIp: '127.0.0.1',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const auth: AuthenticatedSession = {
      account: {
        id: account.id,
        username: account.username,
        displayName: account.displayName,
        isSuperAdmin: options.superAdmin ?? false,
        canCreateRoom: account.canCreateRoom,
      },
      session: { id: session.id, accountId: account.id },
    };
    return { account, auth };
  }

  async function createToastAuth(canCreateRoom = false) {
    const suffix = randomUUID();
    const account = await db.account.create({ data: {
      username: `toast-${suffix}`,
      passwordHash: await hashPassword(`Password-${suffix}`),
      displayName: `Toast ${suffix.slice(0, 8)}`,
      canCreateRoom,
    } });
    const session = await db.accountSession.create({ data: {
      accountId: account.id,
      sessionTokenHash: randomUUID().replaceAll('-', ''),
      deviceId: randomUUID(),
      deviceName: 'Toast Test Browser',
      browser: 'Test',
      operatingSystem: 'Test',
      userAgent: 'Toast integration test',
      loginIp: '127.0.0.1',
      lastIp: '127.0.0.1',
      expiresAt: new Date(Date.now() + 60_000),
    } });
    const auth: AuthenticatedSession = {
      account: { id: account.id, username: account.username, displayName: account.displayName, isSuperAdmin: false, canCreateRoom },
      session: { id: session.id, accountId: account.id },
    };
    return { account, auth };
  }

  async function secondSession(auth: AuthenticatedSession) {
    const session = await db.accountSession.create({
      data: {
        accountId: auth.account.id,
        sessionTokenHash: randomUUID().replaceAll('-', ''),
        deviceId: randomUUID(),
        deviceName: 'Second Test Browser',
        browser: 'Test',
        operatingSystem: 'Test',
        userAgent: 'Task 3 second integration test Session',
        loginIp: '127.0.0.2',
        lastIp: '127.0.0.2',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return {
      ...auth,
      session: { id: session.id, accountId: auth.account.id },
    };
  }

  async function createRoom(creator: AuthenticatedSession, name: string, key = randomUUID(), overrides = {}) {
    return service.createRoom(creator, roomInput(name, overrides), key);
  }

  async function characters(count = 3) {
    const result = await db.character.findMany({
      where: { enabled: true },
      include: { initialProperty: true },
      orderBy: { name: 'asc' },
      take: count,
    });
    expect(result).toHaveLength(count);
    return result;
  }

  it('keeps unseated active members available for bank reassignment', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const admin = await createAuth({ superAdmin: true });
    const unseated = await createAuth({ displayName: '未选人物成员' });
    const room = await createRoom(creator.auth, 'Admin bank candidates');
    const unseatedMembership = await service.joinRoom(unseated.auth, room.id, {}, 'join-unseated-bank-candidate');

    const detail = await service.getAdminRoom(admin.auth, room.id);

    expect(detail.members).toContainEqual(expect.objectContaining({
      id: unseatedMembership.id,
      characterId: null,
      isBank: false,
    }));
  });

  function rejectionCode(result: PromiseSettledResult<unknown>) {
    return result.status === 'rejected' && result.reason instanceof Error
      ? (result.reason as Error & { code?: string }).code
      : null;
  }

  it('enforces room creation permission, persists a password hash, and replays account-scoped creation exactly once', async () => {
    const forbidden = await createAuth();
    const creator = await createAuth({ canCreateRoom: true });
    const otherCreator = await createAuth({ canCreateRoom: true });
    const input = roomInput('Task 3 protected room', { password: 'secret-room-password' });

    await expect(service.createRoom(forbidden.auth, input, 'create-forbidden'))
      .rejects.toMatchObject({ code: 'ROOM_CREATE_FORBIDDEN' });
    const first = await service.createRoom(creator.auth, input, 'same-key');
    const replay = await service.createRoom(creator.auth, { ...input }, 'same-key');
    const otherAccount = await service.createRoom(otherCreator.auth, input, 'same-key');

    expect(replay).toEqual(first);
    expect(otherAccount.id).not.toBe(first.id);
    await expect(service.createRoom(creator.auth, { ...input, name: 'Changed payload' }, 'same-key'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(JSON.stringify({ first, replay, otherAccount })).not.toContain('passwordHash');
    expect(first.hasPassword).toBe(true);
    expect((await db.room.findUniqueOrThrow({ where: { id: first.id } })).passwordHash).toMatch(/^scrypt\$/);
    expect(await db.room.count({ where: { createdByAccountId: creator.account.id } })).toBe(1);
    expect(await db.roomProperty.count({ where: { roomId: first.id } })).toBe(26);
    expect(await db.securityLog.count({ where: { accountId: creator.account.id, action: 'ROOM_CREATED' } })).toBe(1);
  });

  it('requires the correct room password, rate-limits failures, bypasses password checks for members, and joins once', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const joiner = await createAuth({ displayName: '甄嬛' });
    const room = await createRoom(creator.auth, 'Task 3 password room', 'password-room', { password: 'correct-password' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.joinRoom(joiner.auth, room.id, { password: 'wrong-password' }, `wrong-${attempt}`))
        .rejects.toMatchObject({ code: 'ROOM_PASSWORD_INVALID' });
    }
    await expect(service.joinRoom(joiner.auth, room.id, { password: 'correct-password' }, 'rate-limited'))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(await db.securityLog.count({ where: { accountId: joiner.account.id, action: 'ROOM_PASSWORD_FAILED' } })).toBe(5);

    const admitted = await createAuth({ displayName: '甄嬛' });
    const joined = await service.joinRoom(admitted.auth, room.id, { password: 'correct-password' }, 'join-once');
    const replay = await service.joinRoom(admitted.auth, room.id, { password: 'correct-password' }, 'join-once');
    const bypass = await service.joinRoom(admitted.auth, room.id, {}, 'joined-bypass');

    expect(replay).toEqual(joined);
    expect(bypass.id).toBe(joined.id);
    expect(joined).toMatchObject({
      accountId: admitted.account.id,
      displayNameSnapshot: admitted.account.displayName,
      characterId: null,
      isBank: false,
      activeHere: true,
    });
    expectNoSessionIds([joined, replay, bypass], [admitted.auth.session.id]);
    expect(await db.roomMembership.count({ where: { roomId: room.id, accountId: admitted.account.id } })).toBe(1);
    expect(await db.player.count({ where: { roomId: room.id } })).toBe(0);
    expect(await db.securityLog.count({ where: { accountId: admitted.account.id, action: 'ROOM_JOINED' } })).toBe(1);
  });

  it('keeps lobby admission unlimited and joins playing rooms atomically', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const [occupiedCharacter, secondCharacter, thirdCharacter, fourthCharacter, fifthCharacter] = await characters(5);
    const lobby = await createRoom(creator.auth, 'Unlimited lobby');
    const lobbyJoiners = await Promise.all(Array.from({ length: 6 }, () => createAuth()));
    for (const [index, joiner] of lobbyJoiners.entries()) {
      await service.joinRoom(joiner.auth, lobby.id, {}, `unlimited-lobby-${index}`);
    }
    const sixth = await service.joinRoom(lobbyJoiners[5]!.auth, lobby.id, {}, 'unlimited-lobby-sixth');
    expect(sixth).toMatchObject({ status: 'ACTIVE', characterId: null, isBank: false });

    const disabledJoiner = await createAuth();
    const disabledRoom = await createRoom(creator.auth, 'Disabled playing join');
    await db.room.update({ where: { id: disabledRoom.id }, data: { status: 'PLAYING' } });
    await expect(service.joinRoom(
      disabledJoiner.auth,
      disabledRoom.id,
      { characterId: occupiedCharacter!.id },
      'disabled-playing-join',
    )).rejects.toMatchObject({ code: 'MIDGAME_JOIN_DISABLED' });

    const fullJoiner = await createAuth();
    const fullRoom = await createRoom(creator.auth, 'Full playing join', randomUUID(), { allowMidgameJoin: true });
    for (const [index, character] of [occupiedCharacter, secondCharacter, thirdCharacter, fourthCharacter, fifthCharacter].entries()) {
      const occupant = await createAuth();
      await service.joinRoom(occupant.auth, fullRoom.id, {}, `full-occupant-${index}-join`);
      await service.selectCharacter(occupant.auth, fullRoom.id, character!.id, `full-occupant-${index}-character`);
    }
    await db.room.update({ where: { id: fullRoom.id }, data: { status: 'PLAYING' } });
    await expect(service.joinRoom(
      fullJoiner.auth,
      fullRoom.id,
      { characterId: occupiedCharacter!.id },
      'full-playing-join',
    )).rejects.toMatchObject({ code: 'PLAYER_LIMIT' });

    const missingCharacter = await createAuth();
    const openRoom = await createRoom(creator.auth, 'Open playing join', randomUUID(), { allowMidgameJoin: true });
    await db.room.update({ where: { id: openRoom.id }, data: { status: 'PLAYING' } });
    await expect(service.joinRoom(
      missingCharacter.auth,
      openRoom.id,
      {},
      'missing-character-playing-join',
    )).rejects.toMatchObject({ code: 'CHARACTER_REQUIRED' });

    const midgameJoiner = await createAuth();
    const joined = await service.joinRoom(
      midgameJoiner.auth,
      openRoom.id,
      { characterId: occupiedCharacter!.id },
      'open-playing-join',
    );
    expect(joined).toMatchObject({ status: 'ACTIVE', characterId: occupiedCharacter!.id, player: { characterId: occupiedCharacter!.id, balance: 0 } });
    const membership = await db.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: openRoom.id, accountId: midgameJoiner.account.id } },
      include: { player: true },
    });
    expect(membership.player).toMatchObject({ status: 'ACTIVE', characterId: occupiedCharacter!.id, balance: 0 });
    expect(await db.ledgerEntry.count({ where: { roomId: openRoom.id, playerId: membership.player!.id, type: 'INITIAL_BALANCE' } })).toBe(0);
    expect(await db.roomProperty.count({ where: { roomId: openRoom.id, ownerPlayerId: membership.player!.id } })).toBe(0);

    const returningJoiner = await createAuth();
    const returningRoom = await createRoom(creator.auth, 'Returning playing join', randomUUID(), { allowMidgameJoin: true });
    await service.joinRoom(returningJoiner.auth, returningRoom.id, {}, 'returning-lobby-join');
    const original = await service.selectCharacter(returningJoiner.auth, returningRoom.id, secondCharacter!.id, 'returning-lobby-character');
    await db.roomMembership.update({ where: { id: original.id }, data: { status: 'LEFT', leftAt: new Date() } });
    await db.player.update({ where: { id: original.player.id }, data: { status: 'LEFT' } });
    await db.room.update({ where: { id: returningRoom.id }, data: { status: 'PLAYING' } });
    const rejoined = await service.joinRoom(
      returningJoiner.auth,
      returningRoom.id,
      { characterId: secondCharacter!.id },
      'returning-playing-join',
    );
    expect(rejoined).toMatchObject({ id: original.id, player: { id: original.player.id } });
    expect(await db.ledgerEntry.count({ where: { roomId: returningRoom.id, playerId: original.player.id, type: 'INITIAL_BALANCE' } })).toBe(1);
  });

  it('serializes the last midgame seat', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const firstJoiner = await createAuth();
    const secondJoiner = await createAuth();
    const [firstCharacter, secondCharacter, thirdCharacter, fourthCharacter, freeCharacter] = await characters(5);
    const room = await createRoom(creator.auth, 'Last midgame seat', randomUUID(), { allowMidgameJoin: true });
    for (const [index, character] of [firstCharacter, secondCharacter, thirdCharacter, fourthCharacter].entries()) {
      const occupant = await createAuth();
      await service.joinRoom(occupant.auth, room.id, {}, `last-seat-occupant-${index}-join`);
      await service.selectCharacter(occupant.auth, room.id, character!.id, `last-seat-occupant-${index}-character`);
    }
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });
    const clients = [0, 1].map(() => new PrismaClient({ datasources: { db: { url: isolatedTestDatabaseUrl! } } }));
    const [firstService, secondService] = clients.map((client) => new AccountRoomService(client));
    try {
      const outcomes = await Promise.allSettled([
        firstService!.joinRoom(firstJoiner.auth, room.id, { characterId: freeCharacter!.id }, 'last-seat-a'),
        secondService!.joinRoom(secondJoiner.auth, room.id, { characterId: freeCharacter!.id }, 'last-seat-b'),
      ]);
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await db.roomMembership.count({
        where: { roomId: room.id, status: 'ACTIVE', characterId: null, isBank: false },
      })).toBe(0);
      const losingJoiner = outcomes[0]?.status === 'rejected' ? firstJoiner : secondJoiner;
      expect(await service.listRooms(losingJoiner.auth)).toContainEqual(
        expect.objectContaining({ id: room.id, mine: false }),
      );
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it('keeps character and bank as independent capabilities in both acquisition orders', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const first = await createAuth();
    const second = await createAuth();
    const [firstCharacter, secondCharacter] = await characters(2);
    const characterFirstRoom = await createRoom(creator.auth, 'Character then bank');
    const bankFirstRoom = await createRoom(creator.auth, 'Bank then character');

    await service.joinRoom(first.auth, characterFirstRoom.id, {}, 'join-character-first');
    await service.selectCharacter(first.auth, characterFirstRoom.id, firstCharacter!.id, 'character-first');
    await service.selectBank(first.auth, characterFirstRoom.id, 'bank-second');

    await service.joinRoom(second.auth, bankFirstRoom.id, {}, 'join-bank-first');
    await service.selectBank(second.auth, bankFirstRoom.id, 'bank-first');
    await service.selectCharacter(second.auth, bankFirstRoom.id, secondCharacter!.id, 'character-second');

    for (const [roomId, accountId, characterId, sessionId] of [
      [characterFirstRoom.id, first.account.id, firstCharacter!.id, first.auth.session.id],
      [bankFirstRoom.id, second.account.id, secondCharacter!.id, second.auth.session.id],
    ]) {
      const membership = await db.roomMembership.findUniqueOrThrow({
        where: { roomId_accountId: { roomId, accountId } },
        include: { player: true },
      });
      expect(membership).toMatchObject({ characterId, isBank: true, activeSessionId: sessionId });
      expect(membership.player).toMatchObject({ characterId, balance: 6_000 });
      expect(await db.roomMembership.count({ where: { roomId, accountId } })).toBe(1);
      expect(await db.player.count({ where: { roomId, memberId: membership.id } })).toBe(1);
      expect(await db.ledgerEntry.count({ where: { roomId, playerId: membership.player!.id, type: 'INITIAL_BALANCE' } })).toBe(1);
      expect(await db.roomProperty.count({ where: { roomId, ownerPlayerId: membership.player!.id } })).toBe(1);
    }
  });

  it('keeps a bank-only member assetless and grants the initial palace even when cash is zero', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const bankOnly = await createAuth();
    const zeroCash = await createAuth();
    const [character] = await characters(1);
    const bankRoom = await createRoom(creator.auth, 'Bank only');
    const zeroRoom = await createRoom(creator.auth, 'Zero cash palace', randomUUID(), { initialBalance: 0 });

    await service.joinRoom(bankOnly.auth, bankRoom.id, {}, 'join-bank-only');
    await service.selectBank(bankOnly.auth, bankRoom.id, 'select-bank-only');
    const bankMembership = await db.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: bankRoom.id, accountId: bankOnly.account.id } },
    });
    expect(bankMembership).toMatchObject({ characterId: null, isBank: true });
    expect(await db.player.count({ where: { memberId: bankMembership.id } })).toBe(0);
    expect(await db.ledgerEntry.count({ where: { roomId: bankRoom.id } })).toBe(0);
    expect(await db.roomProperty.count({ where: { roomId: bankRoom.id, ownerPlayerId: { not: null } } })).toBe(0);

    await service.joinRoom(zeroCash.auth, zeroRoom.id, {}, 'join-zero');
    await service.selectCharacter(zeroCash.auth, zeroRoom.id, character!.id, 'select-zero');
    const player = await db.player.findFirstOrThrow({ where: { roomId: zeroRoom.id, member: { accountId: zeroCash.account.id } } });
    expect(player.balance).toBe(0);
    expect(await db.ledgerEntry.count({ where: { roomId: zeroRoom.id, playerId: player.id } })).toBe(0);
    expect(await db.gameTransaction.count({ where: { roomId: zeroRoom.id, type: 'INITIAL_BALANCE' } })).toBe(0);
    expect(await db.roomProperty.findFirstOrThrow({ where: { roomId: zeroRoom.id, propertyDefinitionId: character!.initialPropertyId } })).toMatchObject({ ownerPlayerId: player.id });
  });

  it('emits the initial-balance transaction once after the first character selection commit', async () => {
    const committed: Array<{ roomId: string; transactionId: string }> = [];
    const notifiedService = new AccountRoomService(db, () => false, {
      fundsCommitted: (roomId, transactionId) => { committed.push({ roomId, transactionId }); },
      requestRejected: () => undefined,
    });
    const creator = await createToastAuth(true);
    const member = await createToastAuth();
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Initial balance callback');
    await notifiedService.joinRoom(member.auth, room.id, {}, 'join-initial-callback');

    await notifiedService.selectCharacter(member.auth, room.id, character!.id, 'select-initial-callback');
    await notifiedService.selectCharacter(member.auth, room.id, character!.id, 'select-initial-callback');

    const transaction = await db.gameTransaction.findFirstOrThrow({ where: { roomId: room.id, type: 'INITIAL_BALANCE' } });
    expect(committed).toEqual([{ roomId: room.id, transactionId: transaction.id }]);
  });

  it('emits a role-swap initial-balance transaction once after commit', async () => {
    const committed: Array<{ roomId: string; transactionId: string }> = [];
    const notifiedService = new AccountRoomService(db, () => false, {
      fundsCommitted: (roomId, transactionId) => { committed.push({ roomId, transactionId }); },
      requestRejected: () => undefined,
    });
    const creator = await createToastAuth(true);
    const requester = await createToastAuth();
    const target = await createToastAuth();
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Role swap initial balance callback');
    await notifiedService.joinRoom(requester.auth, room.id, {}, 'notify-swap-requester-join');
    await notifiedService.joinRoom(target.auth, room.id, {}, 'notify-swap-target-join');
    await notifiedService.selectCharacter(target.auth, room.id, character!.id, 'notify-swap-target-character');
    committed.length = 0;
    const request = await notifiedService.requestRoleSwap(requester.auth, room.id, character!.id, 'notify-swap-request');

    const accepted = await notifiedService.acceptRoleSwap(target.auth, request.id, 'notify-swap-accept');
    await expect(notifiedService.acceptRoleSwap(target.auth, request.id, 'notify-swap-accept')).resolves.toEqual(accepted);

    const requesterPlayer = await db.player.findFirstOrThrow({ where: { roomId: room.id, member: { accountId: requester.account.id } } });
    const transaction = await db.gameTransaction.findFirstOrThrow({ where: { roomId: room.id, ledgerEntries: { some: { playerId: requesterPlayer.id, type: 'INITIAL_BALANCE' } } } });
    expect(committed).toEqual([{ roomId: room.id, transactionId: transaction.id }]);
  });

  it('replays the same character and rejects a direct second character without duplicating assets or logs', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const member = await createAuth();
    const [firstCharacter, secondCharacter] = await characters(2);
    const room = await createRoom(creator.auth, 'Character limit');
    await service.joinRoom(member.auth, room.id, {}, 'join-limit');

    const selected = await service.selectCharacter(member.auth, room.id, firstCharacter!.id, 'select-same');
    const replay = await service.selectCharacter(member.auth, room.id, firstCharacter!.id, 'select-same');
    const sameCharacterNewKey = await service.selectCharacter(member.auth, room.id, firstCharacter!.id, 'select-same-new-key');
    expect(replay).toEqual(selected);
    expect(sameCharacterNewKey.player.id).toBe(selected.player.id);
    await expect(service.selectCharacter(member.auth, room.id, secondCharacter!.id, 'select-second'))
      .rejects.toMatchObject({ code: 'ACCOUNT_CHARACTER_LIMIT_REACHED' });

    expect(await db.player.count({ where: { roomId: room.id } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { roomId: room.id, type: 'INITIAL_BALANCE' } })).toBe(1);
    expect(await db.roomProperty.count({ where: { roomId: room.id, ownerPlayerId: selected.player.id } })).toBe(1);
    expect(await db.securityLog.count({ where: { accountId: member.account.id, action: 'CHARACTER_SELECTED' } })).toBe(1);
  });

  it('serializes same-character, bank, and same-account different-character races through independent clients', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const first = await createAuth();
    const second = await createAuth();
    const oneAccount = await createAuth();
    const [firstCharacter, secondCharacter, thirdCharacter] = await characters(3);
    const characterRoom = await createRoom(creator.auth, 'Character race');
    const bankRoom = await createRoom(creator.auth, 'Bank race');
    const accountRoom = await createRoom(creator.auth, 'Account character race');
    for (const [auth, roomId, key] of [
      [first.auth, characterRoom.id, 'join-char-first'],
      [second.auth, characterRoom.id, 'join-char-second'],
      [first.auth, bankRoom.id, 'join-bank-first'],
      [second.auth, bankRoom.id, 'join-bank-second'],
      [oneAccount.auth, accountRoom.id, 'join-one-account'],
    ] as const) await service.joinRoom(auth, roomId, {}, key);

    const clients = [0, 1].map(() => new PrismaClient({ datasources: { db: { url: isolatedTestDatabaseUrl! } } }));
    const services = clients.map((client) => new AccountRoomService(client));
    try {
      const characterRace = await Promise.allSettled([
        services[0]!.selectCharacter(first.auth, characterRoom.id, firstCharacter!.id, 'race-character-first'),
        services[1]!.selectCharacter(second.auth, characterRoom.id, firstCharacter!.id, 'race-character-second'),
      ]);
      expect(characterRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(characterRace.map(rejectionCode).filter(Boolean)).toEqual(['ROLE_ALREADY_TAKEN']);
      expect(await db.roomMembership.count({ where: { roomId: characterRoom.id, characterId: firstCharacter!.id } })).toBe(1);
      expect(await db.player.count({ where: { roomId: characterRoom.id } })).toBe(1);
      expect(await db.ledgerEntry.count({ where: { roomId: characterRoom.id, type: 'INITIAL_BALANCE' } })).toBe(1);
      expect(await db.roomProperty.count({ where: { roomId: characterRoom.id, ownerPlayerId: { not: null } } })).toBe(1);

      const bankRace = await Promise.allSettled([
        services[0]!.selectBank(first.auth, bankRoom.id, 'race-bank-first'),
        services[1]!.selectBank(second.auth, bankRoom.id, 'race-bank-second'),
      ]);
      expect(bankRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(bankRace.map(rejectionCode).filter(Boolean)).toEqual(['BANK_ALREADY_TAKEN']);
      expect(await db.roomMembership.count({ where: { roomId: bankRoom.id, isBank: true, status: 'ACTIVE' } })).toBe(1);

      const accountRace = await Promise.allSettled([
        services[0]!.selectCharacter(oneAccount.auth, accountRoom.id, secondCharacter!.id, 'race-account-first'),
        services[1]!.selectCharacter(oneAccount.auth, accountRoom.id, thirdCharacter!.id, 'race-account-second'),
      ]);
      expect(accountRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(accountRace.map(rejectionCode).filter(Boolean)).toEqual(['ACCOUNT_CHARACTER_LIMIT_REACHED']);
      expect(await db.roomMembership.count({ where: { roomId: accountRoom.id, characterId: { not: null } } })).toBe(1);
      expect(await db.player.count({ where: { roomId: accountRoom.id } })).toBe(1);
      expect(await db.ledgerEntry.count({ where: { roomId: accountRoom.id, type: 'INITIAL_BALANCE' } })).toBe(1);
      expect(await db.roomProperty.count({ where: { roomId: accountRoom.id, ownerPlayerId: { not: null } } })).toBe(1);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it('preserves the joining controller across seat selection and atomically transfers shared control', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const member = await createAuth();
    const otherDevice = await secondSession(member.auth);
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Shared control');
    await service.joinRoom(member.auth, room.id, {}, 'join-control');

    await expect(service.selectCharacter(otherDevice, room.id, character!.id, 'select-other-device'))
      .rejects.toMatchObject({ code: 'ROOM_CONTROL_LOST' });
    await expect(service.selectBank(otherDevice, room.id, 'bank-other-device'))
      .rejects.toMatchObject({ code: 'ROOM_CONTROL_LOST' });
    const selectedCharacter = await service.selectCharacter(member.auth, room.id, character!.id, 'select-current-device');
    const selectedBank = await service.selectBank(member.auth, room.id, 'bank-current-device');
    let stored = await db.roomMembership.findUniqueOrThrow({ where: { roomId_accountId: { roomId: room.id, accountId: member.account.id } } });
    expect(stored.activeSessionId).toBe(member.auth.session.id);

    const displacedSessions: string[] = [];
    const takeControl = service.takeControl.bind(service) as unknown as (
      auth: AuthenticatedSession,
      roomId: string,
      key: string,
      afterCommit: (event: { displacedSessionId: string }) => void,
    ) => ReturnType<AccountRoomService['takeControl']>;
    const takeover = await takeControl(otherDevice, room.id, 'take-control', (event) => displacedSessions.push(event.displacedSessionId));
    const replay = await takeControl(otherDevice, room.id, 'take-control', (event) => displacedSessions.push(event.displacedSessionId));
    expect(takeover).toMatchObject({ membership: { activeHere: true } });
    expect(replay).toEqual(takeover);
    expect(displacedSessions).toEqual([member.auth.session.id]);
    expectNoSessionIds(
      [selectedCharacter, selectedBank, takeover, replay],
      [member.auth.session.id, otherDevice.session.id],
    );
    stored = await db.roomMembership.findUniqueOrThrow({ where: { roomId_accountId: { roomId: room.id, accountId: member.account.id } } });
    expect(stored.activeSessionId).toBe(otherDevice.session.id);
    const controlLogs = await db.securityLog.findMany({ where: { accountId: member.account.id, action: 'ROOM_CONTROL_TAKEN' } });
    expect(controlLogs).toHaveLength(1);
    expectNoSessionIds(controlLogs, [member.auth.session.id, otherDevice.session.id]);
  });

  it.each([false, true])('keeps take-control notification state local to the successful serialization retry (already current: %s)', async (durableAlreadyCurrent) => {
    const creator = await createAuth({ canCreateRoom: true });
    const member = await createAuth();
    const otherDevice = await secondSession(member.auth);
    const room = await createRoom(creator.auth, `Control retry ${durableAlreadyCurrent}`);
    await service.joinRoom(member.auth, room.id, {}, `control-retry-join-${durableAlreadyCurrent}`);

    let transactionAttempts = 0;
    const rollback = new Error('roll back injected control attempt');
    const boundaryClient = new Proxy(db, {
      get(targetClient, property, receiver) {
        if (property === '$transaction') {
          return async (...args: unknown[]) => {
            transactionAttempts += 1;
            if (transactionAttempts === 1) {
              const [work, options] = args as [
                (tx: Prisma.TransactionClient) => Promise<unknown>,
                { isolationLevel: Prisma.TransactionIsolationLevel },
              ];
              try {
                await targetClient.$transaction(async (tx) => {
                  await work(tx);
                  throw rollback;
                }, options);
              } catch (error) {
                expect(error).toBe(rollback);
              }
              if (durableAlreadyCurrent) {
                await targetClient.roomMembership.update({
                  where: { roomId_accountId: { roomId: room.id, accountId: member.account.id } },
                  data: { activeSessionId: otherDevice.session.id, controlClaimedAt: new Date() },
                });
              }
              throw new Prisma.PrismaClientKnownRequestError('Injected serialization conflict', {
                code: 'P2034',
                clientVersion: '6.19.0',
              });
            }
            const transaction = Reflect.get(targetClient, property, receiver) as (...input: unknown[]) => unknown;
            return transaction.apply(targetClient, args);
          };
        }
        const value = Reflect.get(targetClient, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(targetClient) : value;
      },
    }) as PrismaClient;
    const displacedSessions: string[] = [];

    const response = await new AccountRoomService(boundaryClient).takeControl(
      otherDevice,
      room.id,
      `control-retry-${durableAlreadyCurrent}`,
      (event) => displacedSessions.push(event.displacedSessionId),
    );

    expect(transactionAttempts).toBe(2);
    expect(response).toMatchObject({ membership: { activeHere: true } });
    expect(displacedSessions).toEqual(durableAlreadyCurrent ? [] : [member.auth.session.id]);
    expect(await db.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: room.id, accountId: member.account.id } },
    })).toMatchObject({ activeSessionId: otherDevice.session.id });
    expect(await db.idempotencyRecord.count({ where: {
      scope: `account:${member.account.id}:room:${room.id}:take-control`,
      key: `control-retry-${durableAlreadyCurrent}`,
    } })).toBe(1);
    expect(await db.securityLog.count({ where: {
      accountId: member.account.id,
      action: 'ROOM_CONTROL_TAKEN',
      detailsJson: { path: ['roomId'], equals: room.id },
    } })).toBe(durableAlreadyCurrent ? 0 : 1);
  });

  it('returns current public seat and lobby snapshots for a dual-capability member without role ambiguity or secrets', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const member = await createAuth({ displayName: '安陵容' });
    const viewer = await createAuth();
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Snapshot room', randomUUID(), { password: 'hidden-password', skillEnabled: false });
    await service.joinRoom(member.auth, room.id, { password: 'hidden-password' }, 'snapshot-join');
    await service.selectCharacter(member.auth, room.id, character!.id, 'snapshot-character');
    await service.selectBank(member.auth, room.id, 'snapshot-bank');

    const seats = await service.seats(member.auth, room.id);
    expect(seats.room).toMatchObject({ id: room.id, skillEnabled: false });
    expect(seats.membership).toMatchObject({
      characterId: character!.id,
      isBank: true,
      activeHere: true,
    });
    expect(seats.membership?.playerId).toBeTypeOf('string');
    expect(seats.characters.find((seat) => seat.id === character!.id)).toMatchObject({
      skill: character!.skillConfig,
      initialProperty: character!.initialProperty.name,
      occupiedBy: member.account.displayName,
      canSelect: false,
    });
    expect(seats.bank).toEqual({ occupiedBy: member.account.displayName });

    const listedForMember = await service.listRooms(member.auth);
    const listedForViewer = await service.listRooms(viewer.auth);
    const mine = listedForMember.find((item) => item.id === room.id)!;
    const publicRoom = listedForViewer.find((item) => item.id === room.id)!;
    expect(mine).toMatchObject({ memberCount: 1, playerCount: 1, mine: true, characterId: character!.id, isBank: true });
    expect(publicRoom).toMatchObject({ memberCount: 1, playerCount: 1, mine: false, characterId: null, isBank: false, hasPassword: true });
    expect(mine).toMatchObject({ createdAt: expect.any(Date), startedAt: null, endedAt: null });
    expect(mine).not.toHaveProperty('myRole');
    expect(JSON.stringify({ seats, listedForMember, listedForViewer })).not.toContain('passwordHash');
    expect(JSON.stringify({ seats, listedForMember, listedForViewer })).not.toContain('sessionTokenHash');
  });

  it('reports authoritative room joinability and available characters', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const seated = await Promise.all(Array.from({ length: 5 }, () => createAuth()));
    const bank = await createAuth();
    const member = await createAuth();
    const viewer = await createAuth();
    const playerCharacters = await characters(5);
    const room = await createRoom(creator.auth, 'Authoritative room admission', randomUUID());

    for (const [index, player] of seated.entries()) {
      await service.joinRoom(player.auth, room.id, {}, `admission-player-${index}`);
      await service.selectCharacter(player.auth, room.id, playerCharacters[index]!.id, `admission-character-${index}`);
    }
    await service.joinRoom(bank.auth, room.id, {}, 'admission-bank');
    await service.selectBank(bank.auth, room.id, 'admission-bank-select');
    const joinedMember = await service.joinRoom(member.auth, room.id, {}, 'admission-member');

    const lobbySummary = (await service.listRooms(viewer.auth)).find((item) => item.id === room.id)!;
    expect(lobbySummary).toMatchObject({
      memberCount: 7,
      playerCount: 5,
      mine: false,
      canJoin: true,
      joinBlockedReason: null,
      availableCharacters: [],
    });
    const activeMemberSummary = (await service.listRooms(member.auth)).find((item) => item.id === room.id)!;
    expect(activeMemberSummary).toMatchObject({ mine: true });

    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING', allowMidgameJoin: false } });
    const disabledPlayingSummary = (await service.listRooms(viewer.auth)).find((item) => item.id === room.id)!;
    expect(disabledPlayingSummary).toMatchObject({
      canJoin: false,
      joinBlockedReason: 'MIDGAME_JOIN_DISABLED',
    });

    await db.room.update({ where: { id: room.id }, data: { allowMidgameJoin: true } });
    const fullPlayingSummary = (await service.listRooms(viewer.auth)).find((item) => item.id === room.id)!;
    expect(fullPlayingSummary).toMatchObject({
      canJoin: false,
      joinBlockedReason: 'PLAYER_LIMIT',
    });

    const releasedCharacter = playerCharacters[0]!;
    const releasedMembership = await db.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: room.id, accountId: seated[0]!.account.id } },
      include: { player: true },
    });
    await db.player.update({ where: { id: releasedMembership.player!.id }, data: { status: 'LEFT' } });
    const openPlayingSummary = (await service.listRooms(viewer.auth)).find((item) => item.id === room.id)!;
    expect(openPlayingSummary).toMatchObject({
      canJoin: true,
      joinBlockedReason: null,
      availableCharacters: [{ id: releasedCharacter.id, name: releasedCharacter.name }],
    });

    await db.roomMembership.update({ where: { id: joinedMember.id }, data: { status: 'LEFT', leftAt: new Date() } });
    await db.room.update({ where: { id: room.id }, data: { visibility: 'PRIVATE' } });
    const leftMemberSummary = (await service.listRooms(member.auth)).find((item) => item.id === room.id)!;
    expect(leftMemberSummary).toMatchObject({ mine: false });
    expect((await service.listRooms(viewer.auth)).find((item) => item.id === room.id)).toBeUndefined();
  });

  it('persists replay for join, character, bank, and control without duplicate rows, assets, or audits', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const member = await createAuth();
    const otherDevice = await secondSession(member.auth);
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Critical replay');

    const publicResponses = [
      await service.joinRoom(member.auth, room.id, {}, 'critical-join'),
      await service.joinRoom(member.auth, room.id, {}, 'critical-join'),
      await service.selectCharacter(member.auth, room.id, character!.id, 'critical-character'),
      await service.selectCharacter(member.auth, room.id, character!.id, 'critical-character'),
      await service.selectBank(member.auth, room.id, 'critical-bank'),
      await service.selectBank(member.auth, room.id, 'critical-bank'),
      await service.takeControl(otherDevice, room.id, 'critical-control'),
      await service.takeControl(otherDevice, room.id, 'critical-control'),
    ];

    await expect(service.joinRoom(member.auth, room.id, { password: 'different-payload' }, 'critical-join'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await db.roomMembership.count({ where: { roomId: room.id, accountId: member.account.id } })).toBe(1);
    expect(await db.player.count({ where: { roomId: room.id } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { roomId: room.id, type: 'INITIAL_BALANCE' } })).toBe(1);
    expect(await db.roomProperty.count({ where: { roomId: room.id, ownerPlayerId: { not: null } } })).toBe(1);
    expect(await db.securityLog.count({ where: { accountId: member.account.id, action: 'ROOM_JOINED' } })).toBe(1);
    expect(await db.securityLog.count({ where: { accountId: member.account.id, action: 'CHARACTER_SELECTED' } })).toBe(1);
    expect(await db.securityLog.count({ where: { accountId: member.account.id, action: 'BANK_SELECTED' } })).toBe(1);
    expect(await db.securityLog.count({ where: { accountId: member.account.id, action: 'ROOM_CONTROL_TAKEN' } })).toBe(1);
    expect(await db.idempotencyRecord.count({ where: { scope: { startsWith: `account:${member.account.id}:` } } })).toBe(4);
    const records = await db.idempotencyRecord.findMany({ where: { scope: { startsWith: `account:${member.account.id}:room:${room.id}:` } } });
    expect(records).toHaveLength(4);
    expectNoSessionIds([publicResponses, records.map((record) => record.response)], [member.auth.session.id, otherDevice.session.id]);
  });

  it('enforces terminal and midgame admission for joins and missing seat capabilities', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const [character] = await characters(1);

    for (const status of ['ENDED', 'FINISHED', 'CLOSED'] as const) {
      const joining = await createAuth();
      const room = await createRoom(creator.auth, `Join ${status}`);
      await db.room.update({ where: { id: room.id }, data: { status } });
      await expect(service.joinRoom(joining.auth, room.id, {}, `join-${status}`))
        .rejects.toMatchObject({ code: 'ROOM_FINISHED' });

      const seated = await createAuth();
      const seatRoom = await createRoom(creator.auth, `Seat ${status}`);
      await service.joinRoom(seated.auth, seatRoom.id, {}, `seat-member-${status}`);
      await db.room.update({ where: { id: seatRoom.id }, data: { status } });
      await expect(service.selectCharacter(seated.auth, seatRoom.id, character!.id, `seat-character-${status}`))
        .rejects.toMatchObject({ code: 'ROOM_FINISHED' });
      await expect(service.selectBank(seated.auth, seatRoom.id, `seat-bank-${status}`))
        .rejects.toMatchObject({ code: 'ROOM_FINISHED' });
      await expect(service.takeControl(seated.auth, seatRoom.id, `seat-control-${status}`))
        .rejects.toMatchObject({ code: 'ROOM_FINISHED' });
    }

    const blockedJoiner = await createAuth();
    const blockedRoom = await createRoom(creator.auth, 'Blocked midgame join');
    await db.room.update({ where: { id: blockedRoom.id }, data: { status: 'PLAYING' } });
    await expect(service.joinRoom(blockedJoiner.auth, blockedRoom.id, {}, 'blocked-midgame-join'))
      .rejects.toMatchObject({ code: 'MIDGAME_JOIN_DISABLED' });

    const blockedSeat = await createAuth();
    const blockedSeatRoom = await createRoom(creator.auth, 'Blocked midgame seat');
    await service.joinRoom(blockedSeat.auth, blockedSeatRoom.id, {}, 'blocked-seat-member');
    await db.room.update({ where: { id: blockedSeatRoom.id }, data: { status: 'PLAYING' } });
    await expect(service.selectCharacter(blockedSeat.auth, blockedSeatRoom.id, character!.id, 'blocked-midgame-character'))
      .rejects.toMatchObject({ code: 'MIDGAME_JOIN_DISABLED' });
    await expect(service.selectBank(blockedSeat.auth, blockedSeatRoom.id, 'blocked-midgame-bank'))
      .rejects.toMatchObject({ code: 'MIDGAME_JOIN_DISABLED' });

    const allowed = await createAuth();
    const allowedRoom = await createRoom(creator.auth, 'Allowed midgame admission', randomUUID(), { allowMidgameJoin: true });
    await db.room.update({ where: { id: allowedRoom.id }, data: { status: 'PLAYING' } });
    await expect(service.joinRoom(allowed.auth, allowedRoom.id, { characterId: character!.id }, 'allowed-midgame-join'))
      .resolves.toMatchObject({ status: 'ACTIVE', characterId: character!.id, player: { characterId: character!.id, balance: 0 } });
    await expect(service.selectBank(allowed.auth, allowedRoom.id, 'allowed-midgame-bank')).resolves.toMatchObject({ isBank: true });
  });

  it('persists safe failed-join replay and rejects changed payloads without another password attempt', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const joiner = await createAuth();
    const room = await createRoom(creator.auth, 'Failed join replay', randomUUID(), { password: 'correct-password' });
    const key = 'failed-join-replay';

    await expect(service.joinRoom(joiner.auth, room.id, { password: 'small-wrong-password' }, key))
      .rejects.toMatchObject({ code: 'ROOM_PASSWORD_INVALID' });
    await expect(service.joinRoom(joiner.auth, room.id, { password: 'small-wrong-password' }, key))
      .rejects.toMatchObject({ code: 'ROOM_PASSWORD_INVALID' });
    expect(await db.securityLog.count({ where: { accountId: joiner.account.id, action: 'ROOM_PASSWORD_FAILED' } })).toBe(1);
    await expect(service.joinRoom(joiner.auth, room.id, { password: 'different-wrong-password' }, key))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    const record = await db.idempotencyRecord.findUniqueOrThrow({
      where: { scope_key: { scope: `account:${joiner.account.id}:room:${room.id}:join`, key } },
    });
    const plainPasswordHash = createHash('sha256').update('small-wrong-password').digest('hex');
    const plainPayloadHash = createHash('sha256').update(JSON.stringify({ password: 'small-wrong-password', roomId: room.id })).digest('hex');
    expect(record.requestHash).toMatch(/^scrypt\$/);
    expect(record.requestHash).not.toBe(plainPasswordHash);
    expect(record.requestHash).not.toBe(plainPayloadHash);
    expect(JSON.stringify(record)).not.toContain('small-wrong-password');
    expect(record.response).toEqual({ error: 'ROOM_PASSWORD_INVALID', ok: false });
  });

  it('serializes concurrent fresh password failures at five attempts and scopes throttling to the room', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const joiner = await createAuth();
    const protectedRoom = await createRoom(creator.auth, 'Concurrent password failures', randomUUID(), { password: 'correct-password' });
    const otherRoom = await createRoom(creator.auth, 'Independent password budget', randomUUID(), { password: 'other-correct-password' });
    const clients = Array.from({ length: 6 }, () => new PrismaClient({ datasources: { db: { url: isolatedTestDatabaseUrl! } } }));

    try {
      const attempts = await Promise.allSettled(clients.map((client, index) =>
        new AccountRoomService(client).joinRoom(joiner.auth, protectedRoom.id, { password: `wrong-${index}` }, `concurrent-wrong-${index}`),
      ));
      expect(attempts.map(rejectionCode).filter((code) => code === 'ROOM_PASSWORD_INVALID')).toHaveLength(5);
      expect(attempts.map(rejectionCode).filter((code) => code === 'RATE_LIMITED')).toHaveLength(1);
      expect(await db.securityLog.count({ where: { accountId: joiner.account.id, action: 'ROOM_PASSWORD_FAILED' } })).toBe(5);
      await expect(service.joinRoom(joiner.auth, otherRoom.id, { password: 'other-correct-password' }, 'other-room-join'))
        .resolves.toMatchObject({ status: 'ACTIVE' });
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it('reuses the deterministic allocation of a Player that is not active', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const retained = await createAuth();
    const newcomer = await createAuth();
    const [retainedCharacter, newCharacter] = await characters(2);
    const room = await createRoom(creator.auth, 'Retained Player slots');
    await service.joinRoom(retained.auth, room.id, {}, 'join-retained');
    const first = await service.selectCharacter(retained.auth, room.id, retainedCharacter!.id, 'select-retained');
    await db.player.update({ where: { id: first.player.id }, data: { status: 'LEFT' } });
    await service.joinRoom(newcomer.auth, room.id, {}, 'join-new-slot');

    const selected = await service.selectCharacter(newcomer.auth, room.id, newCharacter!.id, 'select-new-slot');

    expect(selected.player).toMatchObject({ pawnColor: '胭脂红', turnOrder: 1 });
    expect(await db.player.count({ where: { roomId: room.id } })).toBe(2);
  });

  it('restores a LEFT membership without duplicating its retained row', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const member = await createAuth({ displayName: '流转成员' });
    const joiningDevice = await secondSession(member.auth);
    const room = await createRoom(creator.auth, 'Restore LEFT member', randomUUID(), { password: 'restore-password' });
    const joined = await service.joinRoom(member.auth, room.id, { password: 'restore-password' }, 'initial-left-join');
    await db.roomMembership.update({ where: { id: joined.id }, data: { status: 'LEFT', leftAt: new Date() } });

    await expect(service.joinRoom(joiningDevice, room.id, { password: 'wrong-restore-password' }, 'left-wrong-password'))
      .rejects.toMatchObject({ code: 'ROOM_PASSWORD_INVALID' });
    expect(await db.roomMembership.findUniqueOrThrow({ where: { id: joined.id } })).toMatchObject({ status: 'LEFT' });

    await expect(service.joinRoom(joiningDevice, room.id, { password: 'restore-password' }, 'left-valid-password'))
      .resolves.toMatchObject({ id: joined.id, status: 'ACTIVE', characterId: null, isBank: false });
    expect(await db.roomMembership.count({ where: { roomId: room.id, accountId: member.account.id } })).toBe(1);
    expect(await db.roomMembership.findUniqueOrThrow({ where: { id: joined.id } })).toMatchObject({
      status: 'ACTIVE',
      leftAt: null,
      activeSessionId: joiningDevice.session.id,
    });
  });

  it('reactivates a retained Player only after a rejoined member selects a character again', async () => {
    const admin = await createAuth({ superAdmin: true });
    const creator = await createAuth({ canCreateRoom: true });
    const member = await createAuth({ displayName: '重新入席成员' });
    const [firstCharacter, nextCharacter] = await characters(2);
    const room = await createRoom(creator.auth, 'Removed player reselects');
    const joined = await service.joinRoom(member.auth, room.id, {}, 'removed-player-first-join');
    const selected = await service.selectCharacter(member.auth, room.id, firstCharacter!.id, 'removed-player-first-character');
    const initialLedgerCount = await db.ledgerEntry.count({ where: { roomId: room.id, playerId: selected.player.id, type: 'INITIAL_BALANCE' } });

    await service.removeAdminRoomMember(admin.auth, room.id, joined.id, 'remove-seated-member');
    await expect(service.joinRoom(member.auth, room.id, {}, 'removed-player-rejoin'))
      .resolves.toMatchObject({ id: joined.id, status: 'ACTIVE', characterId: null, isBank: false });
    expect(await db.player.findUniqueOrThrow({ where: { id: selected.player.id } })).toMatchObject({ status: 'LEFT', characterId: null });

    const reselected = await service.selectCharacter(member.auth, room.id, nextCharacter!.id, 'removed-player-next-character');

    expect(reselected.player).toMatchObject({ id: selected.player.id, status: 'ACTIVE', characterId: nextCharacter!.id });
    expect(await db.player.findUniqueOrThrow({ where: { id: selected.player.id } })).toMatchObject({ status: 'ACTIVE', characterId: nextCharacter!.id });
    expect(await db.player.count({ where: { roomId: room.id } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { roomId: room.id, playerId: selected.player.id, type: 'INITIAL_BALANCE' } })).toBe(initialLedgerCount);
  });

  it('replays one concurrent join winner for the same account, room, key, and payload', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const joiner = await createAuth();
    const room = await createRoom(creator.auth, 'Concurrent matching join', randomUUID(), { password: 'matching-password' });
    const clients = [0, 1].map(() => new PrismaClient({ datasources: { db: { url: isolatedTestDatabaseUrl! } } }));
    const scope = `account:${joiner.account.id}:room:${room.id}:join`;

    try {
      const responses = await Promise.all(clients.map((client) =>
        new AccountRoomService(client).joinRoom(joiner.auth, room.id, { password: 'matching-password' }, 'matching-concurrent-key'),
      ));

      expect(responses[1]).toEqual(responses[0]);
      expect(await db.roomMembership.count({ where: { roomId: room.id, accountId: joiner.account.id } })).toBe(1);
      expect(await db.securityLog.count({ where: { accountId: joiner.account.id, action: 'ROOM_JOINED', detailsJson: { path: ['roomId'], equals: room.id } } })).toBe(1);
      expect(await db.idempotencyRecord.count({ where: { scope, key: 'matching-concurrent-key' } })).toBe(1);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it('returns a public persisted winner outcome for conflicting concurrent join payloads under one key', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const joiner = await createAuth();
    const room = await createRoom(creator.auth, 'Concurrent conflicting join', randomUUID(), { password: 'correct-race-password' });
    const clients = [0, 1].map(() => new PrismaClient({ datasources: { db: { url: isolatedTestDatabaseUrl! } } }));
    const scope = `account:${joiner.account.id}:room:${room.id}:join`;

    try {
      const outcomes = await Promise.allSettled([
        new AccountRoomService(clients[0]!).joinRoom(joiner.auth, room.id, { password: 'correct-race-password' }, 'conflicting-concurrent-key'),
        new AccountRoomService(clients[1]!).joinRoom(joiner.auth, room.id, { password: 'wrong-race-password' }, 'conflicting-concurrent-key'),
      ]);
      const codes = outcomes.map(rejectionCode).filter((code): code is string => Boolean(code));
      expect(codes).toContain('IDEMPOTENCY_KEY_REUSED');
      expect(codes.every((code) => ['IDEMPOTENCY_KEY_REUSED', 'ROOM_PASSWORD_INVALID'].includes(code))).toBe(true);
      expect(await db.idempotencyRecord.count({ where: { scope, key: 'conflicting-concurrent-key' } })).toBe(1);

      const membershipCount = await db.roomMembership.count({ where: { roomId: room.id, accountId: joiner.account.id } });
      const joinedLogs = await db.securityLog.count({ where: { accountId: joiner.account.id, action: 'ROOM_JOINED', detailsJson: { path: ['roomId'], equals: room.id } } });
      const failedLogs = await db.securityLog.count({ where: { accountId: joiner.account.id, action: 'ROOM_PASSWORD_FAILED', detailsJson: { path: ['roomId'], equals: room.id } } });
      expect([membershipCount, joinedLogs, failedLogs]).toEqual(
        outcomes.some((outcome) => outcome.status === 'fulfilled') ? [1, 1, 0] : [0, 0, 1],
      );
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it('recovers a persisted join winner after a real P2002 at the custom transaction boundary', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const joiner = await createAuth();
    const room = await createRoom(creator.auth, 'P2002 persisted join winner', randomUUID(), { password: 'winner-password' });
    const key = 'p2002-winner-key';
    const scope = `account:${joiner.account.id}:room:${room.id}:join`;
    const winner = await service.joinRoom(joiner.auth, room.id, { password: 'winner-password' }, key);

    function boundaryClient() {
      let injectConflict = true;
      return new Proxy(db, {
        get(target, property, receiver) {
          if (property === '$transaction') {
            return async (...args: unknown[]) => {
              if (injectConflict) {
                injectConflict = false;
                await db.idempotencyRecord.create({ data: {
                  scope,
                  key,
                  requestHash: 'deliberate-duplicate',
                  response: { deliberate: true },
                } });
              }
              const transaction = Reflect.get(target, property, receiver) as (...input: unknown[]) => unknown;
              return transaction.apply(target, args);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as PrismaClient;
    }

    await expect(new AccountRoomService(boundaryClient()).joinRoom(joiner.auth, room.id, { password: 'winner-password' }, key))
      .resolves.toEqual(winner);
    await expect(new AccountRoomService(boundaryClient()).joinRoom(joiner.auth, room.id, { password: 'changed-password' }, key))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await db.idempotencyRecord.count({ where: { scope, key } })).toBe(1);
    expect(await db.roomMembership.count({ where: { roomId: room.id, accountId: joiner.account.id } })).toBe(1);
    expect(await db.securityLog.count({ where: { accountId: joiner.account.id, action: 'ROOM_JOINED', detailsJson: { path: ['roomId'], equals: room.id } } })).toBe(1);
  });

  it('executes idempotent lobby replacement and mutual swaps without moving assets or bank capability', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const requester = await createAuth();
    const target = await createAuth();
    const [targetCharacter, freeCharacter] = await characters(2);
    const room = await createRoom(creator.auth, 'Lobby replacement');
    await service.joinRoom(requester.auth, room.id, {}, 'replacement-requester-join');
    await service.joinRoom(target.auth, room.id, {}, 'replacement-target-join');
    const selectedTarget = await service.selectCharacter(target.auth, room.id, targetCharacter!.id, 'replacement-target-character');
    await service.selectBank(target.auth, room.id, 'replacement-target-bank');
    const targetBefore = await db.player.findUniqueOrThrow({ where: { id: selectedTarget.player.id } });
    const propertiesBefore = await db.roomProperty.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } });

    const requested = await service.requestRoleSwap(requester.auth, room.id, targetCharacter!.id, 'replacement-request');
    expect(await service.requestRoleSwap(requester.auth, room.id, targetCharacter!.id, 'replacement-request')).toEqual(requested);
    const accepted = await service.acceptRoleSwap(target.auth, requested.id, 'replacement-accept');
    expect(await service.acceptRoleSwap(target.auth, requested.id, 'replacement-accept')).toEqual(accepted);

    const requesterAfter = await db.roomMembership.findUniqueOrThrow({ where: { roomId_accountId: { roomId: room.id, accountId: requester.account.id } }, include: { player: true } });
    const targetAfter = await db.roomMembership.findUniqueOrThrow({ where: { roomId_accountId: { roomId: room.id, accountId: target.account.id } }, include: { player: true } });
    expect(requesterAfter).toMatchObject({ characterId: targetCharacter!.id, isBank: false, activeSessionId: requester.auth.session.id });
    expect(requesterAfter.player).toMatchObject({ balance: 6_000, characterId: targetCharacter!.id });
    expect(targetAfter).toMatchObject({ characterId: null, isBank: true, activeSessionId: target.auth.session.id });
    expect(targetAfter.player).toMatchObject({ id: targetBefore.id, balance: targetBefore.balance, pawnColor: targetBefore.pawnColor, turnOrder: targetBefore.turnOrder });
    expect(await db.auditLog.count({ where: { roomId: room.id, entityId: requested.id } })).toBe(3);
    expect(await db.ledgerEntry.count({ where: { roomId: room.id, playerId: requesterAfter.player!.id, type: 'INITIAL_BALANCE' } })).toBe(1);

    const propertiesAfterReplacement = await db.roomProperty.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } });
    expect(propertiesAfterReplacement.filter((property) => property.ownerPlayerId === targetBefore.id)).toEqual(propertiesBefore.filter((property) => property.ownerPlayerId === targetBefore.id));
    const retainedPlayerId = targetAfter.player!.id;
    const retainedLedgerCount = await db.ledgerEntry.count({ where: { roomId: room.id, playerId: retainedPlayerId } });
    const retainedPropertyIds = (await db.roomProperty.findMany({ where: { roomId: room.id, ownerPlayerId: retainedPlayerId }, select: { id: true }, orderBy: { id: 'asc' } })).map((property) => property.id);
    const reselected = await service.selectCharacter(target.auth, room.id, freeCharacter!.id, 'retained-select-free');
    expect(reselected.player.id).toBe(retainedPlayerId);
    expect(await db.ledgerEntry.count({ where: { roomId: room.id, playerId: retainedPlayerId } })).toBe(retainedLedgerCount);
    expect((await db.roomProperty.findMany({ where: { roomId: room.id, ownerPlayerId: retainedPlayerId }, select: { id: true }, orderBy: { id: 'asc' } })).map((property) => property.id)).toEqual(retainedPropertyIds);

    const mutualRoom = await createRoom(creator.auth, 'Lobby mutual swap');
    const mutualA = await createAuth();
    const mutualB = await createAuth();
    await service.joinRoom(mutualA.auth, mutualRoom.id, {}, 'mutual-a-join');
    await service.joinRoom(mutualB.auth, mutualRoom.id, {}, 'mutual-b-join');
    const playerA = await service.selectCharacter(mutualA.auth, mutualRoom.id, targetCharacter!.id, 'mutual-a-character');
    const playerB = await service.selectCharacter(mutualB.auth, mutualRoom.id, freeCharacter!.id, 'mutual-b-character');
    await service.selectBank(mutualA.auth, mutualRoom.id, 'mutual-a-bank');
    const beforePlayers = await db.player.findMany({ where: { roomId: mutualRoom.id }, orderBy: { id: 'asc' } });
    const mutualRequest = await service.requestRoleSwap(mutualA.auth, mutualRoom.id, freeCharacter!.id, 'mutual-request');
    await service.acceptRoleSwap(mutualB.auth, mutualRequest.id, 'mutual-accept');
    const afterPlayers = await db.player.findMany({ where: { roomId: mutualRoom.id }, orderBy: { id: 'asc' } });
    const invariantPlayerState = (player: typeof afterPlayers[number]) => [
      player.id, player.roomId, player.memberId, player.pawnColor, player.balance, player.status, player.turnOrder,
      player.remainingSkipTurns, player.partnerCardCount, player.version,
    ];
    expect(afterPlayers.map(invariantPlayerState)).toEqual(beforePlayers.map(invariantPlayerState));
    expect(await db.player.findUniqueOrThrow({ where: { id: playerA.player.id } })).toMatchObject({ characterId: freeCharacter!.id });
    expect(await db.player.findUniqueOrThrow({ where: { id: playerB.player.id } })).toMatchObject({ characterId: targetCharacter!.id });
    expect(await db.roomMembership.findUniqueOrThrow({ where: { roomId_accountId: { roomId: mutualRoom.id, accountId: mutualA.account.id } } })).toMatchObject({ isBank: true, activeSessionId: mutualA.auth.session.id });
  });

  it('reactivates a retained Player when a rejoined member acquires a character by role swap', async () => {
    const admin = await createAuth({ superAdmin: true });
    const creator = await createAuth({ canCreateRoom: true });
    const requester = await createAuth({ displayName: '重新换角成员' });
    const target = await createAuth({ displayName: '在席目标成员' });
    const [requesterCharacter, targetCharacter] = await characters(2);
    const room = await createRoom(creator.auth, 'Removed player role swap');
    const requesterMembership = await service.joinRoom(requester.auth, room.id, {}, 'removed-swap-requester-join');
    await service.joinRoom(target.auth, room.id, {}, 'removed-swap-target-join');
    const requesterSeat = await service.selectCharacter(requester.auth, room.id, requesterCharacter!.id, 'removed-swap-requester-character');
    await service.selectCharacter(target.auth, room.id, targetCharacter!.id, 'removed-swap-target-character');
    const initialLedgerCount = await db.ledgerEntry.count({ where: { roomId: room.id, playerId: requesterSeat.player.id, type: 'INITIAL_BALANCE' } });

    await service.removeAdminRoomMember(admin.auth, room.id, requesterMembership.id, 'remove-swap-requester');
    await service.joinRoom(requester.auth, room.id, {}, 'removed-swap-requester-rejoin');
    const requested = await service.requestRoleSwap(requester.auth, room.id, targetCharacter!.id, 'removed-swap-request');
    await service.acceptRoleSwap(target.auth, requested.id, 'removed-swap-accept');

    expect(await db.roomMembership.findUniqueOrThrow({ where: { id: requesterMembership.id } })).toMatchObject({ status: 'ACTIVE', characterId: targetCharacter!.id });
    expect(await db.player.findUniqueOrThrow({ where: { id: requesterSeat.player.id } })).toMatchObject({ status: 'ACTIVE', characterId: targetCharacter!.id });
    expect(await db.player.count({ where: { roomId: room.id, memberId: requesterMembership.id } })).toBe(1);
    expect(await db.ledgerEntry.count({ where: { roomId: room.id, playerId: requesterSeat.player.id, type: 'INITIAL_BALANCE' } })).toBe(initialLedgerCount);
  });

  it('requires distinct target and bank actions in playing swaps and never grants playing-time assets', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const requester = await createAuth();
    const dualTargetBank = await createAuth();
    const [targetCharacter] = await characters(1);
    const room = await createRoom(creator.auth, 'Playing replacement');
    await service.joinRoom(requester.auth, room.id, {}, 'playing-requester-join');
    await service.joinRoom(dualTargetBank.auth, room.id, {}, 'playing-target-join');
    const target = await service.selectCharacter(dualTargetBank.auth, room.id, targetCharacter!.id, 'playing-target-character');
    await service.selectBank(dualTargetBank.auth, room.id, 'playing-target-bank');
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });

    const requested = await service.requestRoleSwap(requester.auth, room.id, targetCharacter!.id, 'playing-request');
    const targetAccepted = await service.acceptRoleSwap(dualTargetBank.auth, requested.id, 'playing-target-accept');
    expect(targetAccepted.status).toBe('PENDING_BANK');
    expect((await db.roomMembership.findUniqueOrThrow({ where: { roomId_accountId: { roomId: room.id, accountId: requester.account.id } } })).characterId).toBeNull();

    const approved = await service.resolveRoleSwap(dualTargetBank.auth, requested.id, 'APPROVE_BANK', 'playing-bank-approve');
    expect(await service.resolveRoleSwap(dualTargetBank.auth, requested.id, 'APPROVE_BANK', 'playing-bank-approve')).toEqual(approved);
    const requesterAfter = await db.roomMembership.findUniqueOrThrow({ where: { roomId_accountId: { roomId: room.id, accountId: requester.account.id } }, include: { player: true } });
    expect(requesterAfter.player).toMatchObject({ balance: 0, characterId: targetCharacter!.id });
    expect(await db.ledgerEntry.count({ where: { roomId: room.id, playerId: requesterAfter.player!.id } })).toBe(0);
    expect(await db.roomProperty.count({ where: { roomId: room.id, ownerPlayerId: requesterAfter.player!.id } })).toBe(0);
    expect(await db.player.findUniqueOrThrow({ where: { id: target.player.id } })).toMatchObject({ id: target.player.id, balance: 6_000, characterId: null });
    const audits = await db.auditLog.findMany({ where: { roomId: room.id, entityId: requested.id }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((audit) => [audit.action, audit.actorRole])).toEqual([
      ['ROLE_SWAP_REQUESTED', 'PLAYER'],
      ['ROLE_SWAP_TARGET_ACCEPTED', 'PLAYER'],
      ['ROLE_SWAP_BANK_CONFIRMED', 'BANK'],
      ['ROLE_SWAP_EXECUTED', 'BANK'],
    ]);
  });

  it('limits role-swap rejection to the target and cancellation to the requester', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const requester = await createAuth();
    const target = await createAuth();
    const outsider = await createAuth();
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Swap decisions');
    for (const [member, key] of [[requester, 'requester'], [target, 'target'], [outsider, 'outsider']] as const) {
      await service.joinRoom(member.auth, room.id, {}, `${key}-join`);
    }
    await service.selectCharacter(target.auth, room.id, character!.id, 'decision-target-character');

    const rejectedRequest = await service.requestRoleSwap(requester.auth, room.id, character!.id, 'decision-request-reject');
    await expect(service.resolveRoleSwap(outsider.auth, rejectedRequest.id, 'REJECT', 'outsider-reject', 'no'))
      .rejects.toMatchObject({ code: 'SWAP_REQUEST_NOT_PENDING' });
    const rejected = await service.resolveRoleSwap(target.auth, rejectedRequest.id, 'REJECT', 'target-reject', 'declined');
    expect(rejected).toMatchObject({ status: 'REJECTED', rejectionReason: 'declined' });
    expect(await service.resolveRoleSwap(target.auth, rejectedRequest.id, 'REJECT', 'target-reject', 'declined')).toEqual(rejected);

    const cancelledRequest = await service.requestRoleSwap(requester.auth, room.id, character!.id, 'decision-request-cancel');
    await expect(service.resolveRoleSwap(target.auth, cancelledRequest.id, 'CANCEL', 'target-cancel'))
      .rejects.toMatchObject({ code: 'SWAP_REQUEST_NOT_PENDING' });
    const cancelled = await service.resolveRoleSwap(requester.auth, cancelledRequest.id, 'CANCEL', 'requester-cancel');
    expect(cancelled.status).toBe('CANCELLED');
    expect(await db.auditLog.count({ where: { roomId: room.id, action: { in: ['ROLE_SWAP_TARGET_REJECTED', 'ROLE_SWAP_CANCELLED'] } } })).toBe(2);
  });

  it('completes a full-capacity lobby replacement while retaining the target Player and assets', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const requester = await createAuth({ displayName: '第六位申请人' });
    const holders = await Promise.all(Array.from({ length: 5 }, (_, index) => createAuth({ displayName: `满席玩家${index + 1}` })));
    const allCharacters = await characters(5);
    const room = await createRoom(creator.auth, 'Full capacity replacement');
    await service.joinRoom(requester.auth, room.id, {}, 'full-requester-join');
    for (const [index, holder] of holders.entries()) {
      await service.joinRoom(holder.auth, room.id, {}, `full-holder-${index}-join`);
      await service.selectCharacter(holder.auth, room.id, allCharacters[index]!.id, `full-holder-${index}-character`);
    }

    const target = holders[2]!;
    const targetMembershipBefore = await db.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: room.id, accountId: target.account.id } },
      include: { player: { include: { ownedProperties: true, ledgerEntries: true } } },
    });
    await service.selectBank(target.auth, room.id, 'full-target-bank');
    await db.player.update({
      where: { id: targetMembershipBefore.player!.id },
      data: { remainingSkipTurns: 2, partnerCardCount: 1 },
    });
    await db.roomProperty.updateMany({
      where: { roomId: room.id, ownerPlayerId: targetMembershipBefore.player!.id },
      data: { buildingLevel: 2, version: { increment: 1 } },
    });
    const targetPlayerBefore = await db.player.findUniqueOrThrow({ where: { id: targetMembershipBefore.player!.id } });
    const targetPropertyBefore = await db.roomProperty.findMany({
      where: { roomId: room.id, ownerPlayerId: targetPlayerBefore.id },
      orderBy: { id: 'asc' },
    });
    const targetLedgerBefore = await db.ledgerEntry.findMany({
      where: { roomId: room.id, playerId: targetPlayerBefore.id },
      orderBy: { id: 'asc' },
    });

    const requested = await service.requestRoleSwap(requester.auth, room.id, allCharacters[2]!.id, 'full-replacement-request');
    const accepted = await service.acceptRoleSwap(target.auth, requested.id, 'full-replacement-accept');

    expect(accepted.status).toBe('APPROVED');
    const requesterAfter = await db.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: room.id, accountId: requester.account.id } },
      include: { player: true },
    });
    const targetAfter = await db.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: room.id, accountId: target.account.id } },
      include: { player: true },
    });
    expect(requesterAfter.player).toMatchObject({
      characterId: allCharacters[2]!.id,
      pawnColor: targetPlayerBefore.pawnColor,
      turnOrder: targetPlayerBefore.turnOrder,
    });
    expect(targetAfter).toMatchObject({
      characterId: null,
      isBank: true,
      activeSessionId: target.auth.session.id,
      player: {
        id: targetPlayerBefore.id,
        characterId: null,
        pawnColor: targetPlayerBefore.pawnColor,
        turnOrder: targetPlayerBefore.turnOrder,
        balance: targetPlayerBefore.balance,
        remainingSkipTurns: 2,
        partnerCardCount: 1,
      },
    });
    expect(await db.roomProperty.findMany({
      where: { roomId: room.id, ownerPlayerId: targetPlayerBefore.id },
      orderBy: { id: 'asc' },
    })).toEqual(targetPropertyBefore);
    expect(await db.ledgerEntry.findMany({
      where: { roomId: room.id, playerId: targetPlayerBefore.id },
      orderBy: { id: 'asc' },
    })).toEqual(targetLedgerBefore);
    const players = await db.player.findMany({ where: { roomId: room.id }, include: { member: true } });
    const playable = players.filter((player) => player.status === 'ACTIVE'
      && player.characterId !== null
      && player.member.status === 'ACTIVE'
      && player.member.characterId === player.characterId);
    expect(players).toHaveLength(6);
    expect(playable).toHaveLength(5);
    expect(playable.map((player) => player.id)).not.toContain(targetPlayerBefore.id);
  });

  it('lets a retained Player reselect during PLAYING but still rejects a genuinely new Player', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const requester = await createAuth();
    const retained = await createAuth();
    const newcomer = await createAuth();
    const [takenCharacter, retainedCharacter, newcomerCharacter] = await characters(3);
    const room = await createRoom(creator.auth, 'Retained playing selection');
    for (const [member, key] of [[requester, 'requester'], [retained, 'retained'], [newcomer, 'newcomer']] as const) {
      await service.joinRoom(member.auth, room.id, {}, `retained-playing-${key}-join`);
    }
    const retainedInitial = await service.selectCharacter(retained.auth, room.id, takenCharacter!.id, 'retained-playing-initial-character');
    const replacement = await service.requestRoleSwap(requester.auth, room.id, takenCharacter!.id, 'retained-playing-request');
    await service.acceptRoleSwap(retained.auth, replacement.id, 'retained-playing-accept');
    const before = await db.player.findUniqueOrThrow({ where: { id: retainedInitial.player.id } });
    const ledgerIds = (await db.ledgerEntry.findMany({ where: { playerId: before.id }, select: { id: true }, orderBy: { id: 'asc' } })).map(({ id }) => id);
    const propertyIds = (await db.roomProperty.findMany({ where: { ownerPlayerId: before.id }, select: { id: true }, orderBy: { id: 'asc' } })).map(({ id }) => id);
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING', allowMidgameJoin: false } });

    const reselected = await service.selectCharacter(retained.auth, room.id, retainedCharacter!.id, 'retained-playing-reselect');

    expect(reselected.player).toMatchObject({ id: before.id, balance: before.balance, characterId: retainedCharacter!.id });
    expect(reselected.player.pawnColor).not.toBe(before.pawnColor);
    expect(reselected.player.turnOrder).not.toBe(before.turnOrder);
    expect((await db.ledgerEntry.findMany({ where: { playerId: before.id }, select: { id: true }, orderBy: { id: 'asc' } })).map(({ id }) => id)).toEqual(ledgerIds);
    expect((await db.roomProperty.findMany({ where: { ownerPlayerId: before.id }, select: { id: true }, orderBy: { id: 'asc' } })).map(({ id }) => id)).toEqual(propertyIds);
    await expect(service.selectCharacter(newcomer.auth, room.id, newcomerCharacter!.id, 'new-playing-player-disabled'))
      .rejects.toMatchObject({ code: 'MIDGAME_JOIN_DISABLED' });
    expect(await db.player.count({ where: { memberId: (await db.roomMembership.findUniqueOrThrow({ where: { roomId_accountId: { roomId: room.id, accountId: newcomer.account.id } } })).id } })).toBe(0);
  });

  it('creates a genuinely new PLAYING Player at zero without a ledger or palace when midgame join is enabled', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const newcomer = await createAuth();
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Enabled midgame selection', randomUUID(), { allowMidgameJoin: true });
    const membership = await service.joinRoom(newcomer.auth, room.id, {}, 'enabled-midgame-join');
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });

    const selected = await service.selectCharacter(newcomer.auth, room.id, character!.id, 'enabled-midgame-character');

    expect(selected.player).toMatchObject({ balance: 0, characterId: character!.id });
    expect(await db.ledgerEntry.count({ where: { roomId: room.id, playerId: selected.player.id } })).toBe(0);
    expect(await db.roomProperty.count({ where: { roomId: room.id, ownerPlayerId: selected.player.id } })).toBe(0);
    expect(await db.player.count({ where: { memberId: membership.id } })).toBe(1);
  });

  it('durably conflicts a PLAYING replacement when the target owns the active turn', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const requester = await createAuth();
    const target = await createAuth();
    const otherPlayer = await createAuth();
    const bank = await createAuth();
    const [targetCharacter, otherCharacter] = await characters(2);
    const room = await createRoom(creator.auth, 'Current target conflict', randomUUID(), { diceMode: 'ELECTRONIC' });
    for (const [member, key] of [[requester, 'requester'], [target, 'target'], [otherPlayer, 'other'], [bank, 'bank']] as const) {
      await service.joinRoom(member.auth, room.id, {}, `current-conflict-${key}-join`);
    }
    const targetSeat = await service.selectCharacter(target.auth, room.id, targetCharacter!.id, 'current-conflict-target-character');
    await service.selectCharacter(otherPlayer.auth, room.id, otherCharacter!.id, 'current-conflict-other-character');
    await service.selectBank(bank.auth, room.id, 'current-conflict-bank');
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });
    const turn = await db.turn.create({ data: { roomId: room.id, playerId: targetSeat.player.id, turnNumber: 1 } });
    await db.room.update({ where: { id: room.id }, data: { currentTurnPlayerId: targetSeat.player.id, turnNumber: 1 } });
    const requested = await service.requestRoleSwap(requester.auth, room.id, targetCharacter!.id, 'current-conflict-request');
    await service.acceptRoleSwap(target.auth, requested.id, 'current-conflict-accept');
    const targetBefore = await db.roomMembership.findUniqueOrThrow({ where: { roomId_accountId: { roomId: room.id, accountId: target.account.id } }, include: { player: true } });
    const propertiesBefore = await db.roomProperty.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } });
    const ledgerBefore = await db.ledgerEntry.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } });

    const conflicted = await service.resolveRoleSwap(bank.auth, requested.id, 'APPROVE_BANK', 'current-conflict-bank-decision');
    const replay = await service.resolveRoleSwap(bank.auth, requested.id, 'APPROVE_BANK', 'current-conflict-bank-decision');

    expect(replay).toEqual(conflicted);
    expect(conflicted).toMatchObject({ status: 'CONFLICTED', resolvedAt: expect.any(String) });
    expect(await db.roleSwapRequest.findUniqueOrThrow({ where: { id: requested.id } })).toMatchObject({ status: 'CONFLICTED', resolvedAt: expect.any(Date) });
    expect(await db.auditLog.count({ where: { roomId: room.id, entityId: requested.id, action: 'ROLE_SWAP_CONFLICTED' } })).toBe(1);
    expect(await db.roomMembership.findUniqueOrThrow({ where: { id: targetBefore.id }, include: { player: true } })).toMatchObject(targetBefore);
    expect(await db.roomMembership.findUniqueOrThrow({ where: { roomId_accountId: { roomId: room.id, accountId: requester.account.id } } })).toMatchObject({ characterId: null });
    expect(await db.player.count({ where: { member: { accountId: requester.account.id }, roomId: room.id } })).toBe(0);
    expect(await db.roomProperty.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } })).toEqual(propertiesBefore);
    expect(await db.ledgerEntry.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } })).toEqual(ledgerBefore);
    expect(await db.turn.findUniqueOrThrow({ where: { id: turn.id } })).toMatchObject({ status: 'ACTIVE', playerId: targetSeat.player.id });
    expect(await db.room.findUniqueOrThrow({ where: { id: room.id } })).toMatchObject({ currentTurnPlayerId: targetSeat.player.id });
  });

  it('durably conflicts a PLAYING replacement when an ACTIVE target Turn disagrees with the room pointer', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const requester = await createAuth();
    const target = await createAuth();
    const otherPlayer = await createAuth();
    const bank = await createAuth();
    const [targetCharacter, otherCharacter] = await characters(2);
    const room = await createRoom(creator.auth, 'Active turn drift conflict', randomUUID(), { diceMode: 'ELECTRONIC' });
    for (const [member, key] of [[requester, 'requester'], [target, 'target'], [otherPlayer, 'other'], [bank, 'bank']] as const) {
      await service.joinRoom(member.auth, room.id, {}, `turn-drift-${key}-join`);
    }
    const targetSeat = await service.selectCharacter(target.auth, room.id, targetCharacter!.id, 'turn-drift-target-character');
    const otherSeat = await service.selectCharacter(otherPlayer.auth, room.id, otherCharacter!.id, 'turn-drift-other-character');
    await service.selectBank(bank.auth, room.id, 'turn-drift-bank');
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });
    const turn = await db.turn.create({ data: { roomId: room.id, playerId: targetSeat.player.id, turnNumber: 1 } });
    await db.room.update({ where: { id: room.id }, data: { currentTurnPlayerId: otherSeat.player.id, turnNumber: 1 } });
    const requested = await service.requestRoleSwap(requester.auth, room.id, targetCharacter!.id, 'turn-drift-request');
    await service.acceptRoleSwap(target.auth, requested.id, 'turn-drift-accept');

    const conflicted = await service.resolveRoleSwap(bank.auth, requested.id, 'APPROVE_BANK', 'turn-drift-bank-decision');

    expect(conflicted).toMatchObject({ status: 'CONFLICTED', rejectionReason: 'TARGET_HAS_ACTIVE_TURN' });
    expect(await db.turn.findUniqueOrThrow({ where: { id: turn.id } })).toMatchObject({ status: 'ACTIVE', playerId: targetSeat.player.id });
    expect(await db.player.findUniqueOrThrow({ where: { id: targetSeat.player.id } })).toMatchObject({ characterId: targetCharacter!.id });
    expect(await db.player.count({ where: { roomId: room.id, member: { accountId: requester.account.id } } })).toBe(0);
  });

  it('terminalizes character drift once and replays the allowlisted conflict DTO', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const requester = await createAuth();
    const target = await createAuth();
    const [requestedCharacter, driftCharacter] = await characters(2);
    const room = await createRoom(creator.auth, 'Character drift conflict');
    await service.joinRoom(requester.auth, room.id, {}, 'drift-requester-join');
    await service.joinRoom(target.auth, room.id, {}, 'drift-target-join');
    const targetSeat = await service.selectCharacter(target.auth, room.id, requestedCharacter!.id, 'drift-target-character');
    const requested = await service.requestRoleSwap(requester.auth, room.id, requestedCharacter!.id, 'drift-request');
    const targetMembership = await db.roomMembership.findUniqueOrThrow({ where: { roomId_accountId: { roomId: room.id, accountId: target.account.id } } });
    await db.roomMembership.update({ where: { id: targetMembership.id }, data: { characterId: null } });
    await db.player.update({ where: { id: targetSeat.player.id }, data: { characterId: null } });
    await db.roomMembership.update({ where: { id: targetMembership.id }, data: { characterId: driftCharacter!.id } });
    await db.player.update({ where: { id: targetSeat.player.id }, data: { characterId: driftCharacter!.id } });
    const propertiesBefore = await db.roomProperty.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } });
    const ledgerBefore = await db.ledgerEntry.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } });

    const conflicted = await service.acceptRoleSwap(target.auth, requested.id, 'drift-accept');
    const replay = await service.acceptRoleSwap(target.auth, requested.id, 'drift-accept');

    expect(replay).toEqual(conflicted);
    expect(Object.keys(conflicted).sort()).toEqual([
      'createdAt', 'id', 'rejectionReason', 'requesterCharacterId', 'requesterMembershipId',
      'resolvedAt', 'roomId', 'stateVersion', 'status', 'targetCharacterId', 'targetMembershipId', 'updatedAt',
    ]);
    expect(conflicted).toMatchObject({ id: requested.id, status: 'CONFLICTED', resolvedAt: expect.any(String) });
    expect(await db.auditLog.count({ where: { roomId: room.id, entityId: requested.id, action: 'ROLE_SWAP_CONFLICTED' } })).toBe(1);
    expect(await db.roomMembership.findUniqueOrThrow({ where: { id: targetMembership.id } })).toMatchObject({ characterId: driftCharacter!.id });
    expect(await db.player.findUniqueOrThrow({ where: { id: targetSeat.player.id } })).toMatchObject({ characterId: driftCharacter!.id });
    expect(await db.player.count({ where: { member: { accountId: requester.account.id }, roomId: room.id } })).toBe(0);
    expect(await db.roomProperty.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } })).toEqual(propertiesBefore);
    expect(await db.ledgerEntry.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } })).toEqual(ledgerBefore);
  });

  it('validates swap keys before lookup and keeps request lookup inside the controlled transaction', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const requester = await createAuth();
    const target = await createAuth();
    const outsider = await createAuth();
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Transaction-only swap lookup');
    for (const [member, key] of [[requester, 'requester'], [target, 'target'], [outsider, 'outsider']] as const) {
      await service.joinRoom(member.auth, room.id, {}, `transaction-lookup-${key}-join`);
    }
    await service.selectCharacter(target.auth, room.id, character!.id, 'transaction-lookup-target-character');
    const requested = await service.requestRoleSwap(requester.auth, room.id, character!.id, 'transaction-lookup-request');

    await expect(service.acceptRoleSwap(outsider.auth, 'missing-request', ''))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    await expect(service.resolveRoleSwap(outsider.auth, 'missing-request', 'CANCEL', ''))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    await expect(service.acceptRoleSwap(outsider.auth, requested.id, 'foreign-probe'))
      .rejects.toMatchObject({ code: 'SWAP_REQUEST_NOT_PENDING' });

    const transactionOnlyClient = new Proxy(db, {
      get(targetClient, property, receiver) {
        if (property === 'roleSwapRequest') {
          const delegate = Reflect.get(targetClient, property, receiver) as object;
          return new Proxy(delegate, {
            get(targetDelegate, delegateProperty, delegateReceiver) {
              if (delegateProperty === 'findUnique') {
                return () => Promise.reject(new Error('ROLE_SWAP_LOOKUP_OUTSIDE_TRANSACTION'));
              }
              const value = Reflect.get(targetDelegate, delegateProperty, delegateReceiver) as unknown;
              return typeof value === 'function' ? value.bind(targetDelegate) : value;
            },
          });
        }
        const value = Reflect.get(targetClient, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(targetClient) : value;
      },
    }) as PrismaClient;
    await expect(new AccountRoomService(transactionOnlyClient).acceptRoleSwap(target.auth, requested.id, 'transaction-only-accept'))
      .resolves.toMatchObject({ id: requested.id, status: 'APPROVED' });
  });

  it('does not reveal whether a request id belongs to a foreign room', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const probe = await createAuth();
    const requester = await createAuth();
    const target = await createAuth();
    const [character] = await characters(1);
    const foreignRoom = await createRoom(creator.auth, 'Foreign request privacy');
    await service.joinRoom(requester.auth, foreignRoom.id, {}, 'foreign-requester-join');
    await service.joinRoom(target.auth, foreignRoom.id, {}, 'foreign-target-join');
    await service.selectCharacter(target.auth, foreignRoom.id, character!.id, 'foreign-target-character');
    const foreignRequest = await service.requestRoleSwap(requester.auth, foreignRoom.id, character!.id, 'foreign-request');

    await expect(service.acceptRoleSwap(probe.auth, 'missing-request', 'missing-request-probe'))
      .rejects.toMatchObject({ code: 'SWAP_REQUEST_NOT_FOUND' });
    await expect(service.acceptRoleSwap(probe.auth, foreignRequest.id, 'foreign-request-probe'))
      .rejects.toMatchObject({ code: 'SWAP_REQUEST_NOT_FOUND' });
  });

  it('scopes swap idempotency by Account and payload and stabilizes concurrent same-key calls', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const requesterA = await createAuth();
    const requesterB = await createAuth();
    const targetA = await createAuth();
    const targetB = await createAuth();
    const [characterA, characterB] = await characters(2);
    const room = await createRoom(creator.auth, 'Swap idempotency matrix');
    for (const [member, key] of [[requesterA, 'requester-a'], [requesterB, 'requester-b'], [targetA, 'target-a'], [targetB, 'target-b']] as const) {
      await service.joinRoom(member.auth, room.id, {}, `idempotency-${key}-join`);
    }
    await service.selectCharacter(targetA.auth, room.id, characterA!.id, 'idempotency-target-a-character');
    await service.selectCharacter(targetB.auth, room.id, characterB!.id, 'idempotency-target-b-character');
    const clients = [0, 1].map(() => new PrismaClient({ datasources: { db: { url: isolatedTestDatabaseUrl! } } }));
    try {
      const [requestA, requestAReplay] = await Promise.all(clients.map((client) =>
        new AccountRoomService(client).requestRoleSwap(requesterA.auth, room.id, characterA!.id, 'concurrent-shared-key'),
      ));
      expect(requestAReplay).toEqual(requestA);
      const requestB = await service.requestRoleSwap(requesterB.auth, room.id, characterB!.id, 'concurrent-shared-key');
      expect(requestB.id).not.toBe(requestA.id);
      await expect(service.requestRoleSwap(requesterA.auth, room.id, characterB!.id, 'concurrent-shared-key'))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

      const rejected = await service.resolveRoleSwap(targetB.auth, requestB.id, 'REJECT', 'changed-decision-key', '首次拒绝');
      expect(rejected).toMatchObject({ status: 'REJECTED', rejectionReason: '首次拒绝' });
      await expect(service.resolveRoleSwap(targetB.auth, requestB.id, 'REJECT', 'changed-decision-key', '篡改拒绝原因'))
        .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

      const decisions = await Promise.all(clients.map((client) =>
        new AccountRoomService(client).acceptRoleSwap(targetA.auth, requestA.id, 'concurrent-decision-key'),
      ));
      expect(decisions[1]).toEqual(decisions[0]);
      expect(await db.auditLog.count({ where: { roomId: room.id, entityId: requestA.id, action: 'ROLE_SWAP_EXECUTED' } })).toBe(1);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it('reauthorizes stale controllers, revoked Sessions, and terminal rooms before swap replay or decision', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const [character] = await characters(1);

    const staleRequester = await createAuth();
    const staleTarget = await createAuth();
    const staleRoom = await createRoom(creator.auth, 'Stale swap replay');
    await service.joinRoom(staleRequester.auth, staleRoom.id, {}, 'stale-swap-requester-join');
    await service.joinRoom(staleTarget.auth, staleRoom.id, {}, 'stale-swap-target-join');
    await service.selectCharacter(staleTarget.auth, staleRoom.id, character!.id, 'stale-swap-target-character');
    const staleRequest = await service.requestRoleSwap(staleRequester.auth, staleRoom.id, character!.id, 'stale-swap-request');
    const accepted = await service.acceptRoleSwap(staleTarget.auth, staleRequest.id, 'stale-swap-accept');
    const controllingTarget = await secondSession(staleTarget.auth);
    await service.takeControl(controllingTarget, staleRoom.id, 'stale-swap-takeover');
    await expect(service.acceptRoleSwap(staleTarget.auth, staleRequest.id, 'stale-swap-accept'))
      .rejects.toMatchObject({ code: 'ROOM_CONTROL_LOST' });
    expect(accepted.status).toBe('APPROVED');

    const revokedRequester = await createAuth();
    const revokedTarget = await createAuth();
    const revokedRoom = await createRoom(creator.auth, 'Revoked swap decision');
    await service.joinRoom(revokedRequester.auth, revokedRoom.id, {}, 'revoked-swap-requester-join');
    await service.joinRoom(revokedTarget.auth, revokedRoom.id, {}, 'revoked-swap-target-join');
    await service.selectCharacter(revokedTarget.auth, revokedRoom.id, character!.id, 'revoked-swap-target-character');
    const revokedRequest = await service.requestRoleSwap(revokedRequester.auth, revokedRoom.id, character!.id, 'revoked-swap-request');
    await db.accountSession.update({ where: { id: revokedTarget.auth.session.id }, data: { revokedAt: new Date() } });
    await expect(service.acceptRoleSwap(revokedTarget.auth, revokedRequest.id, 'revoked-swap-accept'))
      .rejects.toMatchObject({ code: 'SESSION_INVALID' });
    expect(await db.roleSwapRequest.findUniqueOrThrow({ where: { id: revokedRequest.id } })).toMatchObject({ status: 'PENDING_TARGET' });

    const terminalRequester = await createAuth();
    const terminalTarget = await createAuth();
    const terminalRoom = await createRoom(creator.auth, 'Terminal swap decision');
    await service.joinRoom(terminalRequester.auth, terminalRoom.id, {}, 'terminal-swap-requester-join');
    await service.joinRoom(terminalTarget.auth, terminalRoom.id, {}, 'terminal-swap-target-join');
    await service.selectCharacter(terminalTarget.auth, terminalRoom.id, character!.id, 'terminal-swap-target-character');
    const terminalRequest = await service.requestRoleSwap(terminalRequester.auth, terminalRoom.id, character!.id, 'terminal-swap-request');
    await db.room.update({ where: { id: terminalRoom.id }, data: { status: 'FINISHED' } });
    await expect(service.acceptRoleSwap(terminalTarget.auth, terminalRequest.id, 'terminal-swap-accept'))
      .rejects.toMatchObject({ code: 'ROOM_FINISHED' });
    expect(await db.roleSwapRequest.findUniqueOrThrow({ where: { id: terminalRequest.id } })).toMatchObject({ status: 'PENDING_TARGET' });
  });

  it('converts a P2002 without an exact persisted swap winner into TRANSACTION_CONFLICT', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const requester = await createAuth();
    const target = await createAuth();
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Swap P2002 recovery');
    await service.joinRoom(requester.auth, room.id, {}, 'p2002-requester-join');
    await service.joinRoom(target.auth, room.id, {}, 'p2002-target-join');
    await service.selectCharacter(target.auth, room.id, character!.id, 'p2002-target-character');
    let injectConflict = true;
    const boundaryClient = new Proxy(db, {
      get(targetClient, property, receiver) {
        if (property === '$transaction') {
          return async (...args: unknown[]) => {
            if (injectConflict) {
              injectConflict = false;
              throw new Prisma.PrismaClientKnownRequestError('Injected role-swap uniqueness conflict', {
                code: 'P2002',
                clientVersion: '6.19.0',
              });
            }
            const transaction = Reflect.get(targetClient, property, receiver) as (...input: unknown[]) => unknown;
            return transaction.apply(targetClient, args);
          };
        }
        const value = Reflect.get(targetClient, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(targetClient) : value;
      },
    }) as PrismaClient;

    await expect(new AccountRoomService(boundaryClient).requestRoleSwap(
      requester.auth,
      room.id,
      character!.id,
      'p2002-no-winner',
    )).rejects.toMatchObject({ code: 'TRANSACTION_CONFLICT' });
    expect(await db.roleSwapRequest.count({ where: { roomId: room.id, requester: { accountId: requester.account.id } } })).toBe(0);
  });

  it('returns actor-relevant allowlisted role-swap state and derived actions from seats', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const requester = await createAuth({ displayName: '交换申请人' });
    const target = await createAuth({ displayName: '交换目标' });
    const bank = await createAuth({ displayName: '当前银行' });
    const observer = await createAuth({ displayName: '普通成员' });
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Authoritative swap seats');
    for (const [member, key] of [[requester, 'requester'], [target, 'target'], [bank, 'bank'], [observer, 'observer']] as const) {
      await service.joinRoom(member.auth, room.id, {}, `seat-swap-${key}-join`);
    }
    await service.selectCharacter(target.auth, room.id, character!.id, 'seat-swap-target-character');
    await service.selectBank(bank.auth, room.id, 'seat-swap-bank');
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });
    const requested = await service.requestRoleSwap(requester.auth, room.id, character!.id, 'seat-swap-request');

    const requesterSeats = await service.seats(requester.auth, room.id);
    const targetSeats = await service.seats(target.auth, room.id);
    expect(requesterSeats.roleSwapRequests).toHaveLength(1);
    expect(requesterSeats.roleSwapRequests[0]).toMatchObject({
      id: requested.id,
      requesterDisplayName: '交换申请人',
      targetDisplayName: '交换目标',
      actions: { canAccept: false, canReject: false, canCancel: true, canApproveBank: false },
    });
    expect(targetSeats.roleSwapRequests[0]).toMatchObject({
      id: requested.id,
      actions: { canAccept: true, canReject: true, canCancel: false, canApproveBank: false },
    });
    await service.acceptRoleSwap(target.auth, requested.id, 'seat-swap-accept');

    const bankSeats = await service.seats(bank.auth, room.id);
    const observerSeats = await service.seats(observer.auth, room.id);
    expect(bankSeats.roleSwapRequests[0]).toMatchObject({
      id: requested.id,
      status: 'PENDING_BANK',
      actions: { canAccept: false, canReject: false, canCancel: false, canApproveBank: true },
    });
    expect(observerSeats.roleSwapRequests).toEqual([]);
    const allowedKeys = [
      'actions', 'createdAt', 'id', 'rejectionReason', 'requesterCharacterId',
      'requesterDisplayName', 'requesterMembershipId', 'resolvedAt', 'roomId', 'status',
      'targetCharacterId', 'targetDisplayName', 'targetMembershipId', 'updatedAt',
    ];
    expect(Object.keys(bankSeats.roleSwapRequests[0]!).sort()).toEqual(allowedKeys.sort());
    const serialized = JSON.stringify({ requesterSeats, targetSeats, bankSeats, observerSeats });
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('sessionTokenHash');
    expect(serialized).not.toContain('activeSessionId');
  });

  it('keeps actionable role swaps visible beyond the terminal history cap', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const requester = await createAuth();
    const target = await createAuth();
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Actionable swap history');
    await service.joinRoom(requester.auth, room.id, {}, 'history-requester-join');
    await service.joinRoom(target.auth, room.id, {}, 'history-target-join');
    await service.selectCharacter(target.auth, room.id, character!.id, 'history-target-character');
    const pending = await service.requestRoleSwap(requester.auth, room.id, character!.id, 'history-pending-request');
    const requesterMembership = await db.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: room.id, accountId: requester.account.id } },
    });
    const targetMembership = await db.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: room.id, accountId: target.account.id } },
    });
    const terminalCreatedAt = new Date(new Date(pending.createdAt).getTime() + 1_000);
    await db.roleSwapRequest.createMany({ data: Array.from({ length: 101 }, (_, index) => ({
      roomId: room.id,
      requesterMembershipId: requesterMembership.id,
      targetMembershipId: targetMembership.id,
      requesterCharacterId: null,
      targetCharacterId: character!.id,
      status: 'REJECTED' as const,
      rejectionReason: `history-${index}`,
      createdAt: new Date(terminalCreatedAt.getTime() + index),
      updatedAt: new Date(terminalCreatedAt.getTime() + index),
      resolvedAt: new Date(terminalCreatedAt.getTime() + index),
    })) });

    const snapshot = await service.seats(target.auth, room.id);

    expect(snapshot.roleSwapRequests.some((request) => request.id === pending.id)).toBe(true);
    expect(snapshot.roleSwapRequests.find((request) => request.id === pending.id)?.actions.canAccept).toBe(true);
  });

  it('disables role-swap actions for stale controllers and terminal rooms', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const requester = await createAuth();
    const target = await createAuth();
    const bank = await createAuth();
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Controlled swap actions');
    for (const [member, key] of [[requester, 'requester'], [target, 'target'], [bank, 'bank']] as const) {
      await service.joinRoom(member.auth, room.id, {}, `controlled-actions-${key}-join`);
    }
    await service.selectCharacter(target.auth, room.id, character!.id, 'controlled-actions-target-character');
    await service.selectBank(bank.auth, room.id, 'controlled-actions-bank');
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });
    const requested = await service.requestRoleSwap(requester.auth, room.id, character!.id, 'controlled-actions-request');
    const controllingTarget = await secondSession(target.auth);
    await service.takeControl(controllingTarget, room.id, 'controlled-actions-target-takeover');

    const staleTargetRequest = (await service.seats(target.auth, room.id)).roleSwapRequests.find((request) => request.id === requested.id);
    const activeTargetRequest = (await service.seats(controllingTarget, room.id)).roleSwapRequests.find((request) => request.id === requested.id);
    expect(staleTargetRequest?.actions).toMatchObject({ canAccept: false, canReject: false });
    expect(activeTargetRequest?.actions).toMatchObject({ canAccept: true, canReject: true });

    await service.acceptRoleSwap(controllingTarget, requested.id, 'controlled-actions-accept');
    const controllingBank = await secondSession(bank.auth);
    await service.takeControl(controllingBank, room.id, 'controlled-actions-bank-takeover');
    const staleBankRequest = (await service.seats(bank.auth, room.id)).roleSwapRequests.find((request) => request.id === requested.id);
    const activeBankRequest = (await service.seats(controllingBank, room.id)).roleSwapRequests.find((request) => request.id === requested.id);
    expect(staleBankRequest?.actions.canApproveBank).toBe(false);
    expect(activeBankRequest?.actions.canApproveBank).toBe(true);

    await db.room.update({ where: { id: room.id }, data: { status: 'FINISHED' } });
    const terminalRequest = (await service.seats(controllingBank, room.id)).roleSwapRequests.find((request) => request.id === requested.id);
    expect(terminalRequest?.actions.canApproveBank).toBe(false);
  });

  it('previews a coherent allowlisted settlement and reports invalid participant bindings', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const playable = await createAuth({ displayName: '有效玩家' });
    const mismatched = await createAuth({ displayName: '失配留存玩家' });
    const bank = await createAuth({ displayName: '结算银行' });
    const [playableCharacter, mismatchedCharacter] = await characters(2);
    const room = await createRoom(creator.auth, 'Playable settlement eligibility');
    for (const [member, key] of [[playable, 'playable'], [mismatched, 'mismatched'], [bank, 'bank']] as const) {
      await service.joinRoom(member.auth, room.id, {}, `settlement-${key}-join`);
    }
    const playableSeat = await service.selectCharacter(playable.auth, room.id, playableCharacter!.id, 'settlement-playable-character');
    const mismatchedSeat = await service.selectCharacter(mismatched.auth, room.id, mismatchedCharacter!.id, 'settlement-mismatched-character');
    await service.selectBank(bank.auth, room.id, 'settlement-bank');
    await db.player.update({ where: { id: mismatchedSeat.player.id }, data: { characterId: null } });

    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });
    const preview = await service.previewSettlement(bank.auth, room.id, 'MEMBER');
    expect(preview.players.map((player) => player.accountId)).toEqual([playable.account.id]);
    expect(preview.players[0]).toMatchObject({ accountId: playable.account.id, cash: playableSeat.player.balance });
    expect(preview.blockers).toContainEqual({
      code: 'SETTLEMENT_DATA_INVALID',
      membershipId: mismatchedSeat.id,
      playerId: mismatchedSeat.player.id,
    });
    expect(JSON.stringify(preview)).not.toContain('sessionTokenHash');
    expect(await db.gameSettlement.count({ where: { roomId: room.id } })).toBe(0);

    await expect(service.finishRoom(bank.auth, room.id, { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'invalid-binding-finish'))
      .rejects.toMatchObject({ code: 'SETTLEMENT_BLOCKED' });
  });

  it('rejects a participant whose membership and Player belong to different rooms', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const player = await createAuth();
    const bank = await createAuth();
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Cross-room settlement binding');
    const otherRoom = await createRoom(creator.auth, 'Cross-room settlement target');
    await service.joinRoom(player.auth, room.id, {}, 'cross-room-player-join');
    await service.joinRoom(bank.auth, room.id, {}, 'cross-room-bank-join');
    const seat = await service.selectCharacter(player.auth, room.id, character!.id, 'cross-room-character');
    await service.selectBank(bank.auth, room.id, 'cross-room-bank');
    await db.roomProperty.updateMany({ where: { roomId: room.id, ownerPlayerId: seat.player.id }, data: { ownerPlayerId: null } });
    await db.player.update({ where: { id: seat.player.id }, data: { roomId: otherRoom.id } });
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });

    const preview = await service.previewSettlement(bank.auth, room.id);

    expect(preview.players).toEqual([]);
    expect(preview.blockers).toContainEqual({ code: 'SETTLEMENT_DATA_INVALID', membershipId: seat.id, playerId: seat.player.id });
    await expect(service.finishRoom(bank.auth, room.id, { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'cross-room-invalid-finish'))
      .rejects.toMatchObject({ code: 'SETTLEMENT_DATA_INVALID' });
    expect(await db.gameSettlement.count({ where: { roomId: room.id } })).toBe(0);
    expect(await db.idempotencyRecord.count({ where: { scope: `account:${bank.account.id}:room:${room.id}:settlement:finish` } })).toBe(0);
  });

  it('finishes atomically with mortgage-based values and account-scoped replay', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const player = await createAuth({ displayName: '结算玩家' });
    const bank = await createAuth({ displayName: '结算银行' });
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Transactional normal settlement');
    await service.joinRoom(player.auth, room.id, {}, 'normal-player-join');
    await service.joinRoom(bank.auth, room.id, {}, 'normal-bank-join');
    const seat = await service.selectCharacter(player.auth, room.id, character!.id, 'normal-player-character');
    await service.selectBank(bank.auth, room.id, 'normal-bank');
    const owned = await db.roomProperty.findFirstOrThrow({ where: { roomId: room.id, ownerPlayerId: seat.player.id }, include: { definition: true } });
    const buildingProperty = await db.roomProperty.findFirstOrThrow({ where: { roomId: room.id, ownerPlayerId: null, id: { not: owned.id } }, include: { definition: true } });
    const originalDefinition = { purchasePrice: owned.definition.purchasePrice, mortgagePrice: owned.definition.mortgagePrice, buildingSellPrice: owned.definition.buildingSellPrice };
    const originalBuildingDefinition = { buildingSellPrice: buildingProperty.definition.buildingSellPrice };
    await db.propertyDefinition.update({ where: { id: owned.propertyDefinitionId }, data: { purchasePrice: 99_999, mortgagePrice: 900, buildingSellPrice: 350 } });
    await db.propertyDefinition.update({ where: { id: buildingProperty.propertyDefinitionId }, data: { buildingSellPrice: 350 } });
    await db.roomProperty.update({ where: { id: owned.id }, data: { mortgaged: true } });
    await db.roomProperty.update({ where: { id: buildingProperty.id }, data: { ownerPlayerId: seat.player.id, buildingLevel: 2 } });
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING', currentTurnPlayerId: seat.player.id, turnNumber: 7 } });
    const pristineTurn = await db.turn.create({ data: { roomId: room.id, playerId: seat.player.id, turnNumber: 7 } });

    try {
      const first = await service.finishRoom(bank.auth, room.id, { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'normal-finish-key');
      const replay = await service.finishRoom(bank.auth, room.id, { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'normal-finish-key');
      expect(first.created).toBe(true);
      expect(replay).toEqual({ created: false, settlement: first.settlement });
      expect(first.settlement.players).toHaveLength(1);
      expect(first.settlement.players[0]).toMatchObject({
        accountId: player.account.id,
        mortgagedPropertyNetValue: 900,
        buildingSellValue: 700,
      });
      expect(first.settlement.players[0]?.propertyDetails).toContainEqual({
        roomPropertyId: owned.id,
        nameSnapshot: owned.definition.name,
        mortgaged: true,
        mortgagePriceSnapshot: 900,
        landSaleValue: 1_800,
        landSettlementValue: 900,
        buildingLevel: 0,
        buildingSellPriceSnapshot: 350,
        buildingSellValue: 0,
      });
      expect(first.settlement.players[0]?.propertyDetails).toContainEqual(expect.objectContaining({
        roomPropertyId: buildingProperty.id,
        buildingLevel: 2,
        buildingSellPriceSnapshot: 350,
        buildingSellValue: 700,
      }));
      expect(first.settlement.overriddenBlockers).toEqual([]);
      expect(await db.gameSettlement.count({ where: { roomId: room.id } })).toBe(1);
      const endedAt = new Date(first.settlement.endedAt);
      expect(await db.room.findUniqueOrThrow({ where: { id: room.id } })).toMatchObject({
        status: 'FINISHED',
        currentTurnPlayerId: null,
        turnNumber: null,
      });
      expect(await db.turn.findUniqueOrThrow({ where: { id: pristineTurn.id } })).toMatchObject({ status: 'ENDED', endedAt });
      expect(await db.auditLog.findFirstOrThrow({ where: { roomId: room.id, action: 'ROOM_FINISHED' } })).toMatchObject({ createdAt: endedAt });
      expect(await db.securityLog.findFirstOrThrow({ where: { accountId: bank.account.id, action: 'ROOM_FINISHED' } })).toMatchObject({ createdAt: endedAt });
      await expect(service.finishRoom(bank.auth, room.id, { mode: 'NORMAL', confirmation: 'different' }, 'normal-finish-key'))
        .rejects.toMatchObject({ code: 'FINISH_CONFIRMATION_REQUIRED' });
      await expect(service.finishRoom(bank.auth, room.id, { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'different-finish-key'))
        .rejects.toMatchObject({ code: 'ROOM_FINISHED' });
    } finally {
      await db.propertyDefinition.update({ where: { id: owned.propertyDefinitionId }, data: originalDefinition });
      await db.propertyDefinition.update({ where: { id: buildingProperty.propertyDefinitionId }, data: originalBuildingDefinition });
    }
  });

  it('behaviorally recovers exact settlement P2002 winners only after fresh authorization', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const player = await createAuth();
    const bank = await createAuth();
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Settlement P2002 winner');
    await service.joinRoom(player.auth, room.id, {}, 'settlement-p2002-player-join');
    await service.joinRoom(bank.auth, room.id, {}, 'settlement-p2002-bank-join');
    await service.selectCharacter(player.auth, room.id, character!.id, 'settlement-p2002-character');
    const bankMembership = await service.selectBank(bank.auth, room.id, 'settlement-p2002-bank');
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });
    const input = { mode: 'NORMAL' as const, confirmation: '确认结束游戏' };
    const key = 'settlement-p2002-key';
    const winner = await service.finishRoom(bank.auth, room.id, input, key);

    let realConstraintFailures = 0;
    async function boundaryClient() {
      const probe = {
        scope: `settlement-real-p2002:${randomUUID()}`,
        key: 'duplicate-key',
        requestHash: 'probe-hash',
        response: {},
      };
      await db.idempotencyRecord.create({ data: probe });
      let injectConflict = true;
      return new Proxy(db, {
        get(target, property, receiver) {
          if (property === '$transaction') {
            return async (...args: unknown[]) => {
              if (injectConflict) {
                injectConflict = false;
                try {
                  await target.idempotencyRecord.create({ data: probe });
                } catch (error) {
                  expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
                  expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
                  realConstraintFailures += 1;
                  throw error;
                }
                throw new Error('expected the PostgreSQL unique constraint to reject the duplicate probe');
              }
              const transaction = Reflect.get(target, property, receiver) as (...input: unknown[]) => unknown;
              return transaction.apply(target, args);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as PrismaClient;
    }

    await expect(new AccountRoomService(await boundaryClient()).finishRoom(bank.auth, room.id, input, key))
      .resolves.toEqual({ created: false, settlement: winner.settlement });

    const replacementSession = await secondSession(bank.auth);
    await db.roomMembership.update({ where: { id: bankMembership.id }, data: { activeSessionId: replacementSession.session.id } });
    await expect(new AccountRoomService(await boundaryClient()).finishRoom(bank.auth, room.id, input, key))
      .rejects.toMatchObject({ code: 'ROOM_CONTROL_LOST' });
    await db.roomMembership.update({ where: { id: bankMembership.id }, data: { activeSessionId: bank.auth.session.id } });
    await db.accountSession.update({ where: { id: bank.auth.session.id }, data: { revokedAt: new Date() } });
    await expect(new AccountRoomService(await boundaryClient()).finishRoom(bank.auth, room.id, input, key))
      .rejects.toMatchObject({ code: 'SESSION_INVALID' });

    const noWinnerBank = await createAuth();
    const noWinnerPlayer = await createAuth();
    const noWinnerRoom = await createRoom(creator.auth, 'Settlement P2002 without winner');
    await service.joinRoom(noWinnerBank.auth, noWinnerRoom.id, {}, 'no-winner-bank-join');
    await service.joinRoom(noWinnerPlayer.auth, noWinnerRoom.id, {}, 'no-winner-player-join');
    await service.selectBank(noWinnerBank.auth, noWinnerRoom.id, 'no-winner-bank');
    await service.selectCharacter(noWinnerPlayer.auth, noWinnerRoom.id, character!.id, 'no-winner-character');
    await db.room.update({ where: { id: noWinnerRoom.id }, data: { status: 'PLAYING' } });
    await expect(new AccountRoomService(await boundaryClient()).finishRoom(noWinnerBank.auth, noWinnerRoom.id, input, 'missing-winner-key'))
      .rejects.toMatchObject({ code: 'TRANSACTION_CONFLICT' });
    expect(await db.gameSettlement.count({ where: { roomId: noWinnerRoom.id } })).toBe(0);
    expect(realConstraintFailures).toBe(4);
  });

  it('serializes concurrent same-Account same-key finish into one create and one replay', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const player = await createAuth();
    const bank = await createAuth();
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Concurrent matching settlement finish');
    await service.joinRoom(player.auth, room.id, {}, 'concurrent-finish-player-join');
    await service.joinRoom(bank.auth, room.id, {}, 'concurrent-finish-bank-join');
    await service.selectCharacter(player.auth, room.id, character!.id, 'concurrent-finish-character');
    await service.selectBank(bank.auth, room.id, 'concurrent-finish-bank');
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });
    const clients = [0, 1].map(() => new PrismaClient({ datasources: { db: { url: isolatedTestDatabaseUrl! } } }));
    try {
      const input = { mode: 'NORMAL' as const, confirmation: '确认结束游戏' };
      const results = await Promise.all(clients.map((client) =>
        new AccountRoomService(client).finishRoom(bank.auth, room.id, input, 'concurrent-matching-finish'),
      ));
      expect(results.map((result) => result.created).sort()).toEqual([false, true]);
      expect(results[0]!.settlement).toEqual(results[1]!.settlement);
      expect(await db.gameSettlement.count({ where: { roomId: room.id } })).toBe(1);
      expect(await db.auditLog.count({ where: { roomId: room.id, action: 'ROOM_FINISHED' } })).toBe(1);
      expect(await db.securityLog.count({ where: { accountId: bank.account.id, action: 'ROOM_FINISHED' } })).toBe(1);
      expect(await db.idempotencyRecord.count({ where: { scope: `account:${bank.account.id}:room:${room.id}:settlement:finish`, key: 'concurrent-matching-finish' } })).toBe(1);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
  });

  it('forces closure with exact blocker resolution while preserving financial history', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const admin = await createAuth({ superAdmin: true });
    const otherAdmin = await createAuth({ superAdmin: true });
    const player = await createAuth();
    const target = await createAuth();
    const [character, targetCharacter] = await characters(2);
    const room = await createRoom(creator.auth, 'Forced settlement matrix');
    await service.joinRoom(player.auth, room.id, {}, 'forced-player-join');
    await service.joinRoom(target.auth, room.id, {}, 'forced-target-join');
    const playerSeat = await service.selectCharacter(player.auth, room.id, character!.id, 'forced-player-character');
    const targetSeat = await service.selectCharacter(target.auth, room.id, targetCharacter!.id, 'forced-target-character');
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING', currentTurnPlayerId: playerSeat.player.id, turnNumber: 1 } });
    await db.$executeRawUnsafe('ALTER TABLE "Player" DROP CONSTRAINT "Player_balance_check"');
    await db.player.update({ where: { id: playerSeat.player.id }, data: { balance: -25 } });
    const turn = await db.turn.create({ data: { roomId: room.id, playerId: playerSeat.player.id, turnNumber: 1, diceValue: 6, die1: 3, die2: 3, rolledAt: new Date() } });
    const landing = await db.landingEvent.create({ data: { roomId: room.id, turnId: turn.id, playerId: playerSeat.player.id, spaceType: 'PROPERTY', declaredBy: playerSeat.id } });
    const property = await db.roomProperty.findFirstOrThrow({ where: { roomId: room.id, ownerPlayerId: playerSeat.player.id } });
    const request = await db.gameRequest.create({ data: { roomId: room.id, type: 'TRADE_PROPERTY', actorPlayerId: playerSeat.player.id, targetPlayerId: targetSeat.player.id, propertyId: property.id, turnId: turn.id, landingEventId: landing.id, idempotencyKey: randomUUID(), payload: { buyerConfirmed: true } } });
    const genericRequest = await db.gameRequest.create({ data: { roomId: room.id, type: 'BANK_PAYMENT', actorPlayerId: playerSeat.player.id, amount: 10, idempotencyKey: randomUUID() } });
    await db.roomProperty.update({ where: { id: property.id }, data: { lockedByRequestId: request.id } });
    const staleProperty = await db.roomProperty.findFirstOrThrow({ where: { roomId: room.id, id: { not: property.id }, lockedByRequestId: null } });
    const staleRequest = await db.gameRequest.create({ data: { roomId: room.id, type: 'ADJUST_PROPERTY', status: 'APPROVED', propertyId: staleProperty.id, idempotencyKey: randomUUID() } });
    await db.roomProperty.update({ where: { id: staleProperty.id }, data: { lockedByRequestId: staleRequest.id } });
    const swap = await db.roleSwapRequest.create({ data: { roomId: room.id, requesterMembershipId: playerSeat.id, targetMembershipId: targetSeat.id, requesterCharacterId: character!.id, targetCharacterId: targetCharacter!.id } });
    const debt = await db.debtRecord.create({ data: { roomId: room.id, debtorPlayerId: playerSeat.player.id, creditorType: 'TREASURY', originalAmount: 100, outstandingAmount: 75, paidAmount: 25, status: 'PARTIALLY_PAID' } });
    const ledgerCount = await db.ledgerEntry.count({ where: { roomId: room.id } });
    const propertyBefore = await db.roomProperty.findUniqueOrThrow({ where: { id: property.id } });

    const result = await service.finishRoom(admin.auth, room.id, { mode: 'FORCED', reason: '  operational close  ' }, 'forced-finish-key');

    expect(result.created).toBe(true);
    expect(result.settlement.forceReason).toBe('operational close');
    expect(result.settlement.overriddenBlockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      'INCOMPLETE_PROPERTY_TRADE', 'PROPERTY_ACTION_LOCKED', 'PENDING_ROLE_SWAP',
      'PENDING_GAME_REQUEST', 'INVALID_PLAYER_BALANCE', 'OPEN_DEBT', 'UNRESOLVED_LANDING', 'ACTIVE_TURN',
    ]));
    expect(await db.gameRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: 'CANCELLED', rejectionReason: 'FORCED_ROOM_FINISH' });
    expect(await db.gameRequest.findUniqueOrThrow({ where: { id: genericRequest.id } })).toMatchObject({ status: 'CANCELLED', rejectionReason: 'FORCED_ROOM_FINISH' });
    expect(await db.roomProperty.findUniqueOrThrow({ where: { id: property.id } })).toMatchObject({ lockedByRequestId: null, version: propertyBefore.version + 1, ownerPlayerId: propertyBefore.ownerPlayerId });
    expect(await db.roleSwapRequest.findUniqueOrThrow({ where: { id: swap.id } })).toMatchObject({ status: 'CANCELLED', rejectionReason: 'FORCED_ROOM_FINISH' });
    expect(await db.roomProperty.findUniqueOrThrow({ where: { id: staleProperty.id } })).toMatchObject({ lockedByRequestId: null });
    expect(await db.turn.findUniqueOrThrow({ where: { id: turn.id } })).toMatchObject({ status: 'ENDED' });
    expect(await db.landingEvent.findUniqueOrThrow({ where: { id: landing.id } })).toMatchObject({ status: 'INVALIDATED', propertyActionsCancelled: true });
    expect(await db.debtRecord.findUniqueOrThrow({ where: { id: debt.id } })).toMatchObject({ status: 'PARTIALLY_PAID', outstandingAmount: 75 });
    expect(await db.player.findUniqueOrThrow({ where: { id: playerSeat.player.id } })).toMatchObject({ balance: -25 });
    expect(await db.ledgerEntry.count({ where: { roomId: room.id } })).toBe(ledgerCount);
    await expect(service.finishRoom(admin.auth, room.id, { mode: 'FORCED', reason: 'different reason' }, 'forced-finish-key'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(service.finishRoom(otherAdmin.auth, room.id, { mode: 'FORCED', reason: 'operational close' }, 'forced-finish-key'))
      .rejects.toMatchObject({ code: 'ROOM_FINISHED' });
    await db.player.update({ where: { id: playerSeat.player.id }, data: { balance: 0 } });
    await db.$executeRawUnsafe('ALTER TABLE "Player" ADD CONSTRAINT "Player_balance_check" CHECK ("balance" >= 0)');
    const forcedEndedAt = new Date(result.settlement.endedAt);
    expect(await db.room.findUniqueOrThrow({ where: { id: room.id } })).toMatchObject({ currentTurnPlayerId: null, turnNumber: null });
    expect(await db.turn.findUniqueOrThrow({ where: { id: turn.id } })).toMatchObject({ endedAt: forcedEndedAt });
    expect(await db.auditLog.findFirstOrThrow({ where: { roomId: room.id, action: 'ROOM_FORCE_FINISHED' } })).toMatchObject({ createdAt: forcedEndedAt });
    expect(await db.securityLog.findFirstOrThrow({ where: { accountId: admin.account.id, action: 'ROOM_FORCE_FINISHED' } })).toMatchObject({ createdAt: forcedEndedAt });
  });

  it('completes the public electronic workflow from an ended turn to a pristine next turn', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const firstPlayer = await createAuth();
    const secondPlayer = await createAuth();
    const bank = await createAuth();
    const [firstCharacter, secondCharacter] = await characters(2);
    const room = await createRoom(creator.auth, 'Pristine electronic finish', randomUUID(), { diceMode: 'ELECTRONIC' });
    for (const [member, key] of [[firstPlayer, 'first'], [secondPlayer, 'second'], [bank, 'bank']] as const) {
      await service.joinRoom(member.auth, room.id, {}, `pristine-${key}-join`);
    }
    const firstSeat = await service.selectCharacter(firstPlayer.auth, room.id, firstCharacter!.id, 'pristine-first-character');
    await service.selectCharacter(secondPlayer.auth, room.id, secondCharacter!.id, 'pristine-second-character');
    await service.selectBank(bank.auth, room.id, 'pristine-bank');
    const games = new PrismaGameService(db, () => 0);
    const bankActor = { accountId: bank.account.id, sessionId: bank.auth.session.id };
    const playerActor = { accountId: firstPlayer.account.id, sessionId: firstPlayer.auth.session.id };

    await games.start(bankActor, room.id, 'pristine-start');
    await games.roll(playerActor, room.id, firstSeat.player.id, 'pristine-roll');
    const owned = await db.roomProperty.findFirstOrThrow({ where: { roomId: room.id, ownerPlayerId: firstSeat.player.id }, include: { definition: true } });
    const landing = await games.declareLanding(playerActor, room.id, firstSeat.player.id, owned.definition.name, 'pristine-landing');
    await games.confirmLanding(bankActor, room.id, landing.id, true, 'pristine-confirm');
    await games.endTurn(playerActor, room.id, firstSeat.player.id, 'pristine-end-turn');

    const preview = await service.previewSettlement(bank.auth, room.id);
    expect(preview.blockers).toEqual([]);
    const pristine = await db.turn.findFirstOrThrow({ where: { roomId: room.id, status: 'ACTIVE' } });
    expect(pristine).toMatchObject({ die1: null, die2: null, diceValue: null, rolledAt: null });

    const result = await service.finishRoom(bank.auth, room.id, { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'pristine-finish');
    expect(result.settlement.totalTurns).toBe(2);
    expect(await db.turn.count({ where: { roomId: room.id, status: 'ACTIVE' } })).toBe(0);
    expect(await db.room.findUniqueOrThrow({ where: { id: room.id } })).toMatchObject({ status: 'FINISHED', currentTurnPlayerId: null, startedAt: expect.any(Date) });
  });

  it('uses competition ranking, joint winners, bank-only exclusion, and one dual-member row', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const firstPlayer = await createAuth({ displayName: '并列甲' });
    const secondPlayer = await createAuth({ displayName: '并列乙' });
    const thirdPlayer = await createAuth({ displayName: '第三名' });
    const bankOnly = await createAuth({ displayName: '纯银行' });
    const [firstCharacter, secondCharacter, thirdCharacter] = await characters(3);
    const room = await createRoom(creator.auth, 'Settlement participant ranking');
    for (const [member, key] of [[firstPlayer, 'first'], [secondPlayer, 'second'], [thirdPlayer, 'third'], [bankOnly, 'bank']] as const) {
      await service.joinRoom(member.auth, room.id, {}, `ranking-${key}-join`);
    }
    const firstSeat = await service.selectCharacter(firstPlayer.auth, room.id, firstCharacter!.id, 'ranking-first-character');
    const secondSeat = await service.selectCharacter(secondPlayer.auth, room.id, secondCharacter!.id, 'ranking-second-character');
    const thirdSeat = await service.selectCharacter(thirdPlayer.auth, room.id, thirdCharacter!.id, 'ranking-third-character');
    await service.selectBank(bankOnly.auth, room.id, 'ranking-bank');
    await db.roomProperty.updateMany({ where: { roomId: room.id }, data: { ownerPlayerId: null, buildingLevel: 0, mortgaged: false } });
    await db.player.update({ where: { id: firstSeat.player.id }, data: { balance: 3_000 } });
    await db.player.update({ where: { id: secondSeat.player.id }, data: { balance: 3_000 } });
    await db.player.update({ where: { id: thirdSeat.player.id }, data: { balance: 2_000 } });
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });

    const preview = await service.previewSettlement(bankOnly.auth, room.id);
    expect(preview.players.map(({ accountId, rank, isWinner }) => ({ accountId, rank, isWinner }))).toEqual([
      { accountId: [firstPlayer.account.id, secondPlayer.account.id].sort()[0], rank: 1, isWinner: true },
      { accountId: [firstPlayer.account.id, secondPlayer.account.id].sort()[1], rank: 1, isWinner: true },
      { accountId: thirdPlayer.account.id, rank: 3, isWinner: false },
    ]);
    expect(preview.players.some((player) => player.accountId === bankOnly.account.id)).toBe(false);

    const dualCreator = await createAuth({ canCreateRoom: true });
    const dual = await createAuth({ displayName: '人物兼银行' });
    const dualRoom = await createRoom(dualCreator.auth, 'Dual participant settlement');
    await service.joinRoom(dual.auth, dualRoom.id, {}, 'dual-settlement-join');
    await service.selectCharacter(dual.auth, dualRoom.id, firstCharacter!.id, 'dual-settlement-character');
    await service.selectBank(dual.auth, dualRoom.id, 'dual-settlement-bank');
    await db.room.update({ where: { id: dualRoom.id }, data: { status: 'PLAYING' } });
    expect((await service.previewSettlement(dual.auth, dualRoom.id)).players.map((player) => player.accountId)).toEqual([dual.account.id]);
  });

  it('excludes a public-replacement retained Player and negative balance without changing retained assets or history', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const retained = await createAuth({ displayName: '留存资产玩家' });
    const active = await createAuth({ displayName: '有效玩家' });
    const bank = await createAuth({ displayName: '接替者兼银行' });
    const [retainedCharacter, activeCharacter] = await characters(2);
    const room = await createRoom(creator.auth, 'Retained replacement settlement');
    for (const [member, key] of [[retained, 'retained'], [active, 'active'], [bank, 'bank']] as const) {
      await service.joinRoom(member.auth, room.id, {}, `retained-settlement-${key}-join`);
    }
    const retainedSeat = await service.selectCharacter(retained.auth, room.id, retainedCharacter!.id, 'retained-settlement-character');
    await service.selectCharacter(active.auth, room.id, activeCharacter!.id, 'active-settlement-character');
    await service.selectBank(bank.auth, room.id, 'retained-settlement-bank');
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });

    const requested = await service.requestRoleSwap(bank.auth, room.id, retainedCharacter!.id, 'retained-settlement-request');
    await service.acceptRoleSwap(retained.auth, requested.id, 'retained-settlement-accept');
    await service.resolveRoleSwap(bank.auth, requested.id, 'APPROVE_BANK', 'retained-settlement-approve');
    const retainedMembership = await db.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: room.id, accountId: retained.account.id } },
      include: { player: true },
    });
    const dualMembership = await db.roomMembership.findUniqueOrThrow({
      where: { roomId_accountId: { roomId: room.id, accountId: bank.account.id } },
      include: { player: true },
    });
    expect(retainedMembership).toMatchObject({ characterId: null, player: { id: retainedSeat.player.id, characterId: null } });
    expect(dualMembership).toMatchObject({ characterId: retainedCharacter!.id, isBank: true, player: { characterId: retainedCharacter!.id } });

    await db.$executeRawUnsafe('ALTER TABLE "Player" DROP CONSTRAINT "Player_balance_check"');
    try {
      await db.player.update({ where: { id: retainedSeat.player.id }, data: { balance: -75 } });
      const before = {
        player: await db.player.findUniqueOrThrow({ where: { id: retainedSeat.player.id } }),
        properties: await db.roomProperty.findMany({ where: { roomId: room.id, ownerPlayerId: retainedSeat.player.id }, orderBy: { id: 'asc' } }),
        ledger: await db.ledgerEntry.findMany({ where: { roomId: room.id, playerId: retainedSeat.player.id }, orderBy: { id: 'asc' } }),
        transactions: await db.gameTransaction.findMany({ where: { roomId: room.id, ledgerEntries: { some: { playerId: retainedSeat.player.id } } }, orderBy: { id: 'asc' } }),
      };

      const preview = await service.previewSettlement(bank.auth, room.id);
      expect(preview.players.map((player) => player.accountId)).toEqual(expect.arrayContaining([active.account.id, bank.account.id]));
      expect(preview.players.filter((player) => player.accountId === bank.account.id)).toHaveLength(1);
      expect(preview.players.some((player) => player.accountId === retained.account.id)).toBe(false);
      expect(preview.blockers.some((blocker) => blocker.code === 'INVALID_PLAYER_BALANCE' || blocker.code === 'SETTLEMENT_DATA_INVALID')).toBe(false);

      const finished = await service.finishRoom(bank.auth, room.id, { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'retained-settlement-finish');
      expect(finished.settlement.players.map((player) => player.accountId)).toEqual(expect.arrayContaining([active.account.id, bank.account.id]));
      expect(finished.settlement.players.some((player) => player.accountId === retained.account.id)).toBe(false);
      expect({
        player: await db.player.findUniqueOrThrow({ where: { id: retainedSeat.player.id } }),
        properties: await db.roomProperty.findMany({ where: { roomId: room.id, ownerPlayerId: retainedSeat.player.id }, orderBy: { id: 'asc' } }),
        ledger: await db.ledgerEntry.findMany({ where: { roomId: room.id, playerId: retainedSeat.player.id }, orderBy: { id: 'asc' } }),
        transactions: await db.gameTransaction.findMany({ where: { roomId: room.id, ledgerEntries: { some: { playerId: retainedSeat.player.id } } }, orderBy: { id: 'asc' } }),
      }).toEqual(before);
    } finally {
      await db.player.update({ where: { id: retainedSeat.player.id }, data: { balance: 0 } });
      await db.$executeRawUnsafe('ALTER TABLE "Player" ADD CONSTRAINT "Player_balance_check" CHECK ("balance" >= 0)');
    }
  });

  it('enforces the complete preview, finish, and legacy lifecycle matrix', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const admin = await createAuth({ superAdmin: true });
    const ordinary = await createAuth();
    const bank = await createAuth();
    const player = await createAuth();
    const [character] = await characters(1);

    const lobby = await createRoom(creator.auth, 'Settlement lifecycle lobby');
    await service.joinRoom(bank.auth, lobby.id, {}, 'lifecycle-lobby-bank-join');
    await service.joinRoom(player.auth, lobby.id, {}, 'lifecycle-lobby-player-join');
    await service.selectBank(bank.auth, lobby.id, 'lifecycle-lobby-bank');
    await service.selectCharacter(player.auth, lobby.id, character!.id, 'lifecycle-lobby-character');
    await expect(service.previewSettlement(bank.auth, lobby.id)).rejects.toMatchObject({ code: 'ROOM_NOT_PLAYING' });
    await expect(service.finishRoom(bank.auth, lobby.id, { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'lifecycle-lobby-normal'))
      .rejects.toMatchObject({ code: 'ROOM_NOT_PLAYING' });
    await expect(service.previewSettlement(ordinary.auth, lobby.id, 'ADMIN')).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    await expect(service.previewSettlement(admin.auth, lobby.id, 'ADMIN')).resolves.toMatchObject({ blockers: [] });
    await expect(service.finishRoom(ordinary.auth, lobby.id, { mode: 'FORCED', reason: 'ordinary force' }, 'ordinary-force'))
      .rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
    await expect(service.finishRoom(admin.auth, lobby.id, { mode: 'FORCED', reason: '  ' }, 'blank-force'))
      .rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    await expect(service.finishRoom(admin.auth, lobby.id, { mode: 'FORCED', reason: 'lobby close' }, 'lobby-force'))
      .resolves.toMatchObject({ created: true, settlement: { forced: true, forceReason: 'lobby close' } });

    const endedBank = await createAuth();
    const endedPlayer = await createAuth();
    const ended = await createRoom(creator.auth, 'Settlement lifecycle ended');
    await service.joinRoom(endedBank.auth, ended.id, {}, 'lifecycle-ended-bank-join');
    await service.joinRoom(endedPlayer.auth, ended.id, {}, 'lifecycle-ended-player-join');
    await service.selectBank(endedBank.auth, ended.id, 'lifecycle-ended-bank');
    await service.selectCharacter(endedPlayer.auth, ended.id, character!.id, 'lifecycle-ended-character');
    await db.room.update({ where: { id: ended.id }, data: { status: 'ENDED' } });
    await expect(service.previewSettlement(endedBank.auth, ended.id)).rejects.toMatchObject({ code: 'LEGACY_SETTLEMENT_UNAVAILABLE' });
    await expect(service.getSettlement(endedPlayer.auth, ended.id)).rejects.toMatchObject({ code: 'LEGACY_SETTLEMENT_UNAVAILABLE' });
    await expect(service.finishRoom(endedBank.auth, ended.id, { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'ended-normal'))
      .rejects.toMatchObject({ code: 'LEGACY_SETTLEMENT_UNAVAILABLE' });
    await expect(service.previewSettlement(admin.auth, ended.id, 'ADMIN')).resolves.toMatchObject({ blockers: [] });
    await expect(service.finishRoom(admin.auth, ended.id, { mode: 'FORCED', reason: 'legacy finalization' }, 'ended-force'))
      .resolves.toMatchObject({ created: true, settlement: { forced: true } });

    const corruptBank = await createAuth();
    const corrupt = await createRoom(creator.auth, 'Settlement lifecycle corrupt');
    await service.joinRoom(corruptBank.auth, corrupt.id, {}, 'lifecycle-corrupt-bank-join');
    await service.selectBank(corruptBank.auth, corrupt.id, 'lifecycle-corrupt-bank');
    await db.room.update({ where: { id: corrupt.id }, data: { status: 'FINISHED' } });
    await expect(service.previewSettlement(corruptBank.auth, corrupt.id)).rejects.toMatchObject({ code: 'SETTLEMENT_INCONSISTENT' });
    await expect(service.getSettlement(corruptBank.auth, corrupt.id)).rejects.toMatchObject({ code: 'SETTLEMENT_INCONSISTENT' });
    await expect(service.finishRoom(admin.auth, corrupt.id, { mode: 'FORCED', reason: 'cannot fabricate' }, 'corrupt-force'))
      .rejects.toMatchObject({ code: 'SETTLEMENT_INCONSISTENT' });

    const closed = await createRoom(creator.auth, 'Settlement lifecycle closed');
    await db.room.update({ where: { id: closed.id }, data: { status: 'CLOSED' } });
    await expect(service.finishRoom(admin.auth, closed.id, { mode: 'FORCED', reason: 'closed' }, 'closed-force'))
      .rejects.toMatchObject({ code: 'ROOM_FINISHED' });
    await expect(service.getSettlement(admin.auth, closed.id, 'ADMIN')).rejects.toMatchObject({ code: 'SETTLEMENT_NOT_FOUND' });
  });

  it('freshly validates bank capability, controller, Session, Account, and admin privilege', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const bank = await createAuth();
    const player = await createAuth();
    const admin = await createAuth({ superAdmin: true });
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Settlement fresh authorization');
    await service.joinRoom(bank.auth, room.id, {}, 'fresh-auth-bank-join');
    await service.joinRoom(player.auth, room.id, {}, 'fresh-auth-player-join');
    await service.selectBank(bank.auth, room.id, 'fresh-auth-bank');
    await service.selectCharacter(player.auth, room.id, character!.id, 'fresh-auth-character');
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });
    await expect(service.previewSettlement(player.auth, room.id)).rejects.toMatchObject({ code: 'BANK_REQUIRED' });

    const activeBank = await secondSession(bank.auth);
    await service.takeControl(activeBank, room.id, 'fresh-auth-control');
    await expect(service.previewSettlement(bank.auth, room.id)).rejects.toMatchObject({ code: 'ROOM_CONTROL_LOST' });
    await expect(service.previewSettlement(activeBank, room.id)).resolves.toMatchObject({ blockers: [] });
    await db.account.update({ where: { id: bank.account.id }, data: { status: 'DISABLED' } });
    await expect(service.previewSettlement(activeBank, room.id)).rejects.toMatchObject({ code: 'SESSION_INVALID' });

    configuredSuperAdmins.delete(admin.account.username);
    await expect(service.previewSettlement(admin.auth, room.id, 'ADMIN')).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
  });

  it('returns the same immutable DTO to LEFT members and current nonmember admins only', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const bank = await createAuth();
    const player = await createAuth({ displayName: '历史成员名' });
    const outsider = await createAuth();
    const admin = await createAuth({ superAdmin: true });
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Settlement read authorization');
    await service.joinRoom(bank.auth, room.id, {}, 'read-bank-join');
    await service.joinRoom(player.auth, room.id, {}, 'read-player-join');
    await service.selectBank(bank.auth, room.id, 'read-bank');
    const playerSeat = await service.selectCharacter(player.auth, room.id, character!.id, 'read-character');
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });
    const finished = await service.finishRoom(bank.auth, room.id, { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'read-finish');
    const before = finished.settlement;
    const ownedDetail = before.players[0]?.propertyDetails[0] as { roomPropertyId?: string } | undefined;
    await db.account.update({ where: { id: player.account.id }, data: { displayName: '后来账号名' } });
    await db.character.update({ where: { id: character!.id }, data: { name: `后来人物名-${randomUUID()}` } });
    if (ownedDetail?.roomPropertyId) {
      const owned = await db.roomProperty.findUniqueOrThrow({ where: { id: ownedDetail.roomPropertyId } });
      await db.propertyDefinition.update({ where: { id: owned.propertyDefinitionId }, data: { mortgagePrice: { increment: 111 }, buildingSellPrice: { increment: 77 } } });
    }
    await db.roomMembership.update({ where: { id: playerSeat.id }, data: { status: 'LEFT', leftAt: new Date() } });

    await expect(service.getSettlement(player.auth, room.id)).resolves.toEqual(before);
    await expect(service.getSettlement(bank.auth, room.id)).resolves.toEqual(before);
    await expect(service.getSettlement(outsider.auth, room.id)).rejects.toMatchObject({ code: 'ROOM_MEMBERSHIP_REQUIRED' });
    await expect(service.getSettlement(admin.auth, room.id, 'ADMIN')).resolves.toEqual(before);
  });

  it('projects allowlisted stored settlement JSON and rejects malformed required shapes', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const reader = await createAuth();
    const validRoom = await createRoom(creator.auth, 'Legacy settlement JSON projection');
    await service.joinRoom(reader.auth, validRoom.id, {}, 'legacy-json-reader-join');
    const valid = await db.gameSettlement.create({ data: {
      roomId: validRoom.id,
      endedByAccountId: creator.account.id,
      totalTurns: 1,
      durationSeconds: 10,
      winnersJson: [reader.account.id],
      rankingJson: [{ accountId: reader.account.id, rank: 1, internalSecret: 'ranking-secret' }],
      overriddenBlockersJson: [{ code: 'ACTIVE_TURN', turnId: 'turn-safe', playerId: 'player-safe', internalSecret: 'blocker-secret' }],
      players: { create: [{
        accountId: reader.account.id,
        displayNameSnapshot: '历史玩家',
        characterNameSnapshot: '历史人物',
        cash: 1_000,
        unmortgagedPropertyValue: 1_800,
        mortgagedPropertyNetValue: 0,
        buildingSellValue: 350,
        totalWealth: 3_150,
        rank: 1,
        isWinner: true,
        propertyDetailsJson: [{
          roomPropertyId: 'room-property-safe',
          nameSnapshot: '历史地产',
          mortgaged: false,
          mortgagePriceSnapshot: 900,
          landSaleValue: 1_800,
          landSettlementValue: 1_800,
          buildingLevel: 1,
          buildingSellPriceSnapshot: 350,
          buildingSellValue: 350,
          internalSecret: 'property-secret',
        }],
      }] },
    } });
    await db.room.update({ where: { id: validRoom.id }, data: { status: 'FINISHED' } });

    const projected = await service.getSettlement(reader.auth, validRoom.id);
    expect(projected).toMatchObject({
      id: valid.id,
      winners: [reader.account.id],
      ranking: [{ accountId: reader.account.id, rank: 1 }],
      overriddenBlockers: [{ code: 'ACTIVE_TURN', turnId: 'turn-safe', playerId: 'player-safe' }],
      players: [{ propertyDetails: [{
        roomPropertyId: 'room-property-safe',
        nameSnapshot: '历史地产',
        mortgaged: false,
        mortgagePriceSnapshot: 900,
        landSaleValue: 1_800,
        landSettlementValue: 1_800,
        buildingLevel: 1,
        buildingSellPriceSnapshot: 350,
        buildingSellValue: 350,
      }] }],
    });
    expect(JSON.stringify(projected)).not.toContain('internalSecret');

    const malformedRoom = await createRoom(creator.auth, 'Malformed legacy settlement JSON');
    await service.joinRoom(reader.auth, malformedRoom.id, {}, 'malformed-json-reader-join');
    await db.gameSettlement.create({ data: {
      roomId: malformedRoom.id,
      endedByAccountId: creator.account.id,
      totalTurns: 0,
      durationSeconds: 0,
      winnersJson: [reader.account.id],
      rankingJson: [{ accountId: 42, rank: 'first' }],
      overriddenBlockersJson: [],
    } });
    await db.room.update({ where: { id: malformedRoom.id }, data: { status: 'FINISHED' } });

    await expect(service.getSettlement(reader.auth, malformedRoom.id))
      .rejects.toMatchObject({ code: 'SETTLEMENT_INCONSISTENT' });
  });

  it('recomputes assets at finish instead of persisting stale preview values', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const player = await createAuth();
    const bank = await createAuth();
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Settlement asset drift');
    await service.joinRoom(player.auth, room.id, {}, 'asset-drift-player-join');
    await service.joinRoom(bank.auth, room.id, {}, 'asset-drift-bank-join');
    const seat = await service.selectCharacter(player.auth, room.id, character!.id, 'asset-drift-character');
    await service.selectBank(bank.auth, room.id, 'asset-drift-bank');
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });
    const preview = await service.previewSettlement(bank.auth, room.id);
    await db.player.update({ where: { id: seat.player.id }, data: { balance: { increment: 777 }, version: { increment: 1 } } });

    const result = await service.finishRoom(bank.auth, room.id, { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'asset-drift-finish');

    expect(result.settlement.players[0]?.cash).toBe(preview.players[0]!.cash + 777);
    expect(result.settlement.players[0]?.totalWealth).toBe(preview.players[0]!.totalWealth + 777);
  });

  it('serializes finish against game writes and role-swap requests on the Room lock', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const player = await createAuth();
    const bank = await createAuth();
    const [character] = await characters(1);
    const gameRoom = await createRoom(creator.auth, 'Finish versus game write');
    await service.joinRoom(player.auth, gameRoom.id, {}, 'finish-game-player-join');
    await service.joinRoom(bank.auth, gameRoom.id, {}, 'finish-game-bank-join');
    const seat = await service.selectCharacter(player.auth, gameRoom.id, character!.id, 'finish-game-character');
    await service.selectBank(bank.auth, gameRoom.id, 'finish-game-bank');
    await db.room.update({ where: { id: gameRoom.id }, data: { status: 'PLAYING' } });
    const initialBalance = seat.player.balance;
    const gameClients = [0, 1].map(() => new PrismaClient({ datasources: { db: { url: isolatedTestDatabaseUrl! } } }));
    try {
      const finishService = new AccountRoomService(gameClients[0]!);
      const gameService = new PrismaGameService(gameClients[1]!);
      const [finishOutcome, gameOutcome] = await Promise.allSettled([
        finishService.finishRoom(bank.auth, gameRoom.id, { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'concurrent-game-finish'),
        gameService.adjustBalance({ accountId: bank.account.id, sessionId: bank.auth.session.id }, gameRoom.id, seat.player.id, 250, 'concurrent settlement adjustment', 'concurrent-game-adjust'),
      ]);
      expect(finishOutcome.status).toBe('fulfilled');
      if (finishOutcome.status !== 'fulfilled') throw finishOutcome.reason;
      const expectedCash = gameOutcome.status === 'fulfilled' ? initialBalance + 250 : initialBalance;
      expect(finishOutcome.value.settlement.players[0]?.cash).toBe(expectedCash);
      if (gameOutcome.status === 'rejected') expect(rejectionCode(gameOutcome)).toBe('ROOM_FINISHED');
      expect((await db.player.findUniqueOrThrow({ where: { id: seat.player.id } })).balance).toBe(expectedCash);
    } finally {
      await Promise.all(gameClients.map((client) => client.$disconnect()));
    }

    const requester = await createAuth();
    const target = await createAuth();
    const swapBank = await createAuth();
    const swapRoom = await createRoom(creator.auth, 'Finish versus role swap');
    await service.joinRoom(requester.auth, swapRoom.id, {}, 'finish-swap-requester-join');
    await service.joinRoom(target.auth, swapRoom.id, {}, 'finish-swap-target-join');
    await service.joinRoom(swapBank.auth, swapRoom.id, {}, 'finish-swap-bank-join');
    await service.selectCharacter(target.auth, swapRoom.id, character!.id, 'finish-swap-character');
    await service.selectBank(swapBank.auth, swapRoom.id, 'finish-swap-bank');
    await db.room.update({ where: { id: swapRoom.id }, data: { status: 'PLAYING' } });
    const swapClients = [0, 1].map(() => new PrismaClient({ datasources: { db: { url: isolatedTestDatabaseUrl! } } }));
    try {
      const [finishOutcome, swapOutcome] = await Promise.allSettled([
        new AccountRoomService(swapClients[0]!).finishRoom(swapBank.auth, swapRoom.id, { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'concurrent-swap-finish'),
        new AccountRoomService(swapClients[1]!).requestRoleSwap(requester.auth, swapRoom.id, character!.id, 'concurrent-swap-request'),
      ]);
      expect([finishOutcome.status, swapOutcome.status]).toContain('fulfilled');
      if (finishOutcome.status === 'fulfilled') {
        expect(rejectionCode(swapOutcome)).toBe('ROOM_FINISHED');
        expect(await db.roleSwapRequest.count({ where: { roomId: swapRoom.id, status: { in: ['PENDING_TARGET', 'PENDING_BANK'] } } })).toBe(0);
      } else {
        expect(rejectionCode(finishOutcome)).toBe('SETTLEMENT_BLOCKED');
        expect(swapOutcome.status).toBe('fulfilled');
        expect(await db.gameSettlement.count({ where: { roomId: swapRoom.id } })).toBe(0);
      }
    } finally {
      await Promise.all(swapClients.map((client) => client.$disconnect()));
    }
  });

  it('rejects all five role-swap actions without mutation in every terminal Room state', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const [character] = await characters(1);
    for (const status of ['ENDED', 'FINISHED', 'CLOSED'] as const) {
      const requester = await createAuth();
      const target = await createAuth();
      const bank = await createAuth();
      const room = await createRoom(creator.auth, `Terminal swaps ${status}`);
      for (const [member, key] of [[requester, 'requester'], [target, 'target'], [bank, 'bank']] as const) {
        await service.joinRoom(member.auth, room.id, {}, `terminal-${status}-${key}-join`);
      }
      const targetSeat = await service.selectCharacter(target.auth, room.id, character!.id, `terminal-${status}-character`);
      const bankSeat = await service.selectBank(bank.auth, room.id, `terminal-${status}-bank`);
      const pendingTarget = await service.requestRoleSwap(requester.auth, room.id, character!.id, `terminal-${status}-request`);
      const pendingBank = await db.roleSwapRequest.create({ data: {
        roomId: room.id,
        requesterMembershipId: pendingTarget.requesterMembershipId,
        targetMembershipId: targetSeat.id,
        targetCharacterId: character!.id,
        status: 'PENDING_BANK',
      } });
      await db.room.update({ where: { id: room.id }, data: { status } });
      const before = {
        requests: await db.roleSwapRequest.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } }),
        audits: await db.auditLog.count({ where: { roomId: room.id } }),
        idempotency: await db.idempotencyRecord.count(),
      };

      await expect(service.requestRoleSwap(requester.auth, room.id, character!.id, `terminal-${status}-new-request`)).rejects.toMatchObject({ code: 'ROOM_FINISHED' });
      await expect(service.acceptRoleSwap(target.auth, pendingTarget.id, `terminal-${status}-accept`)).rejects.toMatchObject({ code: 'ROOM_FINISHED' });
      await expect(service.resolveRoleSwap(target.auth, pendingTarget.id, 'REJECT', `terminal-${status}-reject`, 'no')).rejects.toMatchObject({ code: 'ROOM_FINISHED' });
      await expect(service.resolveRoleSwap(requester.auth, pendingTarget.id, 'CANCEL', `terminal-${status}-cancel`)).rejects.toMatchObject({ code: 'ROOM_FINISHED' });
      await expect(service.resolveRoleSwap(bank.auth, pendingBank.id, 'APPROVE_BANK', `terminal-${status}-approve`)).rejects.toMatchObject({ code: 'ROOM_FINISHED' });

      expect(await db.roleSwapRequest.findMany({ where: { roomId: room.id }, orderBy: { id: 'asc' } })).toEqual(before.requests);
      expect(await db.auditLog.count({ where: { roomId: room.id } })).toBe(before.audits);
      expect(await db.idempotencyRecord.count()).toBe(before.idempotency);
      expect(bankSeat.isBank).toBe(true);
    }
  });

  it('reauthorizes settlement operations and keeps immutable snapshot rows byte-stable', async () => {
    const creator = await createAuth({ canCreateRoom: true });
    const bank = await createAuth();
    const player = await createAuth();
    const [character] = await characters(1);
    const room = await createRoom(creator.auth, 'Immutable settlement rows');
    await service.joinRoom(bank.auth, room.id, {}, 'immutable-bank-join');
    await service.joinRoom(player.auth, room.id, {}, 'immutable-player-join');
    await service.selectBank(bank.auth, room.id, 'immutable-bank');
    await service.selectCharacter(player.auth, room.id, character!.id, 'immutable-character');
    await db.room.update({ where: { id: room.id }, data: { status: 'PLAYING' } });
    const finished = await service.finishRoom(bank.auth, room.id, { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'immutable-finish');
    const stored = await db.gameSettlement.findUniqueOrThrow({ where: { roomId: room.id }, include: { players: true } });
    const before = JSON.stringify(stored);

    await expect(db.$executeRawUnsafe(`UPDATE "GameSettlement" SET "durationSeconds" = 9 WHERE "id" = '${finished.settlement.id}'`)).rejects.toThrow(/immutable/);
    await expect(db.gameSettlement.delete({ where: { id: finished.settlement.id } })).rejects.toThrow(/immutable/);
    await expect(db.$executeRawUnsafe('TRUNCATE TABLE "GameSettlement", "SettlementPlayer"')).rejects.toThrow(/immutable/);
    await expect(db.gameSettlement.create({ data: {
      roomId: room.id,
      endedByAccountId: creator.account.id,
      totalTurns: 0,
      durationSeconds: 0,
      winnersJson: [],
      rankingJson: [],
      overriddenBlockersJson: [],
    } })).rejects.toThrow(/immutable/);
    await expect(db.settlementPlayer.update({ where: { id: stored.players[0]!.id }, data: { cash: { increment: 1 } } })).rejects.toThrow(/immutable/);
    await expect(db.$executeRawUnsafe(`DELETE FROM "SettlementPlayer" WHERE "settlementId" = '${finished.settlement.id}'`)).rejects.toThrow(/immutable/);
    await expect(db.$executeRawUnsafe('TRUNCATE TABLE "SettlementPlayer"')).rejects.toThrow(/immutable/);
    await expect(db.settlementPlayer.create({ data: {
      settlementId: finished.settlement.id,
      accountId: creator.account.id,
      displayNameSnapshot: 'late row',
      characterNameSnapshot: null,
      cash: 0,
      unmortgagedPropertyValue: 0,
      mortgagedPropertyNetValue: 0,
      buildingSellValue: 0,
      totalWealth: 0,
      rank: 2,
      isWinner: false,
      propertyDetailsJson: [],
    } })).rejects.toThrow(/immutable/);
    await expect(db.room.update({ where: { id: room.id }, data: { status: 'CLOSED' } })).rejects.toThrow(/terminal status is immutable/);
    expect(JSON.stringify(await db.gameSettlement.findUniqueOrThrow({ where: { roomId: room.id }, include: { players: true } }))).toBe(before);

    await db.accountSession.update({ where: { id: bank.auth.session.id }, data: { revokedAt: new Date() } });
    await expect(service.finishRoom(bank.auth, room.id, { mode: 'NORMAL', confirmation: '确认结束游戏' }, 'immutable-finish'))
      .rejects.toMatchObject({ code: 'SESSION_INVALID' });

    await expect(service.getSettlement(player.auth, room.id, 'MEMBER')).resolves.toMatchObject({ id: finished.settlement.id });
  });
});
