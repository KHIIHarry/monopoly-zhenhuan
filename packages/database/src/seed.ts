import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { loadMasterData, type RawMasterData } from '@zhenhuan/shared';
import { prisma } from './index.js';

const source = fileURLToPath(
  new URL('../../../monopoly-zhenhuan_master-data.json', import.meta.url),
);

function bootstrapPasswordHash(password: string) {
  return new Promise<string>((resolve, reject) => {
    const salt = randomBytes(16);
    scryptCallback(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error);
      else resolve(`scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`);
    });
  });
}

function parseSuperAdminUsernames(value: string | undefined) {
  if (!value?.trim()) {
    throw new Error('SUPER_ADMIN_USERNAMES is required');
  }

  const usernames = value.split(',').map((username) => username.trim());
  if (usernames.some((username) => !username)) {
    throw new Error('SUPER_ADMIN_USERNAMES must not contain empty usernames');
  }

  const superAdminUsernames = new Set(usernames);
  if (superAdminUsernames.size !== usernames.length) {
    throw new Error('SUPER_ADMIN_USERNAMES must not contain duplicate usernames');
  }

  return superAdminUsernames;
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`INVALID_MASTER_DATA:${field}`);
  }
}

function assertMasterData(raw: unknown): asserts raw is RawMasterData {
  if (!raw || typeof raw !== 'object') throw new Error('INVALID_MASTER_DATA:root');

  const data = raw as Partial<RawMasterData>;
  if (data.currency !== '两') throw new Error('INVALID_MASTER_DATA:currency');
  if (!Array.isArray(data.properties) || data.properties.length !== 26) {
    throw new Error('INVALID_MASTER_DATA:properties');
  }
  if (!Array.isArray(data.characters) || data.characters.length !== 5) {
    throw new Error('INVALID_MASTER_DATA:characters');
  }

  const propertyNames = new Set<string>();
  for (const [index, property] of data.properties.entries()) {
    if (!property || typeof property.name !== 'string' || !property.name.trim()) {
      throw new Error(`INVALID_MASTER_DATA:properties[${index}].name`);
    }
    if (propertyNames.has(property.name)) {
      throw new Error(`INVALID_MASTER_DATA:duplicate-property:${property.name}`);
    }
    propertyNames.add(property.name);
    assertNonNegativeInteger(property.mortgage, `properties[${index}].mortgage`);
    assertNonNegativeInteger(property.sale, `properties[${index}].sale`);
    assertNonNegativeInteger(property.build, `properties[${index}].build`);
    assertNonNegativeInteger(property.building_sell, `properties[${index}].building_sell`);
    if (!Array.isArray(property.tolls) || property.tolls.length !== 6) {
      throw new Error(`INVALID_MASTER_DATA:properties[${index}].tolls`);
    }
    property.tolls.forEach((toll, tollIndex) =>
      assertNonNegativeInteger(toll, `properties[${index}].tolls[${tollIndex}]`),
    );
  }

  const characterIds = new Set<string>();
  for (const [index, character] of data.characters.entries()) {
    if (
      !character ||
      typeof character.id !== 'string' ||
      typeof character.name !== 'string' ||
      typeof character.initialProperty !== 'string' ||
      !character.skill ||
      typeof character.skill.code !== 'string' ||
      !character.skill.config ||
      typeof character.skill.config !== 'object'
    ) {
      throw new Error(`INVALID_MASTER_DATA:characters[${index}]`);
    }
    if (characterIds.has(character.id)) {
      throw new Error(`INVALID_MASTER_DATA:duplicate-character:${character.id}`);
    }
    if (!propertyNames.has(character.initialProperty)) {
      throw new Error(`INVALID_MASTER_DATA:initial-property:${character.initialProperty}`);
    }
    characterIds.add(character.id);
    for (const [key, value] of Object.entries(character.skill.config)) {
      assertNonNegativeInteger(value, `characters[${index}].skill.config.${key}`);
    }
  }
}

export async function readMasterData() {
  const raw: unknown = JSON.parse(await readFile(source, 'utf8'));
  assertMasterData(raw);
  return loadMasterData(raw);
}

export async function seed() {
  const superAdminUsernames = parseSuperAdminUsernames(process.env.SUPER_ADMIN_USERNAMES);
  const data = await readMasterData();
  const bootstrap = {
    username: process.env.BOOTSTRAP_ADMIN_USERNAME,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    displayName: process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME,
  };
  const configuredBootstrapFields = Object.values(bootstrap).filter(Boolean).length;
  if (configuredBootstrapFields > 0 && configuredBootstrapFields < 3) throw new Error('BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD and BOOTSTRAP_ADMIN_DISPLAY_NAME must be set together');
  if (bootstrap.password && bootstrap.password.length < 12) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters');
  if (bootstrap.username && !superAdminUsernames.has(bootstrap.username)) {
    throw new Error('BOOTSTRAP_ADMIN_USERNAME_NOT_CONFIGURED');
  }
  const bootstrapHash = bootstrap.password ? await bootstrapPasswordHash(bootstrap.password) : null;

  await prisma.$transaction(async (tx) => {
    for (const [index, property] of data.properties.entries()) {
      const values = {
        displayOrder: index + 1,
        mortgagePrice: property.mortgage,
        purchasePrice: property.purchasePrice,
        buildCost: property.build,
        buildingSellPrice: property.buildingSell,
        tollEmpty: property.tolls[0],
        tollLevel1: property.tolls[1],
        tollLevel2: property.tolls[2],
        tollLevel3: property.tolls[3],
        tollLevel4: property.tolls[4],
        tollPalace: property.tolls[5],
      };

      await tx.propertyDefinition.upsert({
        where: { name: property.name },
        update: values,
        create: { name: property.name, ...values },
      });
    }

    for (const character of data.characters) {
      const values = {
        name: character.name,
        skillCode: character.skill.code,
        skillConfig: character.skill.config,
        initialProperty: { connect: { name: character.initialProperty } },
      };

      await tx.character.upsert({
        where: { id: character.id },
        update: values,
        create: { id: character.id, ...values },
      });
    }

    if (bootstrap.username && bootstrap.displayName && bootstrapHash) {
      const existing = await tx.account.findUnique({ where: { username: bootstrap.username } });
      if (existing) {
        if (
          existing.status !== 'ACTIVE' ||
          !existing.canCreateRoom
        ) {
          throw new Error('BOOTSTRAP_ADMIN_USERNAME_CONFLICT');
        }
      } else {
        await tx.account.create({ data: {
          username: bootstrap.username,
          passwordHash: bootstrapHash,
          displayName: bootstrap.displayName,
          canCreateRoom: true,
          note: 'Bootstrap administrator',
        } });
      }
    }
  });

  return { properties: data.properties.length, characters: data.characters.length, bootstrapAdmin: Boolean(bootstrapHash) };
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    const result = await seed();
    console.log(
      `Seeded ${result.properties} properties and ${result.characters} characters from Master Data.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
