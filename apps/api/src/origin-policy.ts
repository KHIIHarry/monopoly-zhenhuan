export type OriginPolicy = {
  originAllowed: (origin?: string) => boolean;
  secureCookie: boolean;
};

const localDevelopmentOrigin = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/;

function isPrivateIpv4(value: string) {
  const octets = value.split('.');
  if (octets.length !== 4) return false;
  if (octets.some((part) => !/^\d+$/.test(part) || Number(part) > 255 || String(Number(part)) !== part)) return false;
  const [first, second] = octets.map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function requireExactLanHttpOrigin(value: string) {
  try {
    const parsed = new URL(value);
    if (
      parsed.origin !== value
      || parsed.protocol !== 'http:'
      || parsed.port !== '3000'
      || parsed.username
      || parsed.password
      || !isPrivateIpv4(parsed.hostname)
    ) throw new Error('invalid');
    return parsed.origin;
  } catch {
    throw new Error('LAN_HTTP_ORIGIN must be an exact HTTP origin using an RFC1918 private IPv4 address and port 3000');
  }
}

function requireExactProductionHttpsOrigin(value?: string) {
  try {
    const configuredOrigin = value?.trim() ?? '';
    const parsed = new URL(configuredOrigin);
    if (parsed.origin !== configuredOrigin || parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('invalid');
    return parsed.origin;
  } catch {
    throw new Error('APP_ORIGIN must be one exact HTTPS origin in production');
  }
}

export function loadOriginPolicy(env: NodeJS.ProcessEnv = process.env): OriginPolicy {
  const production = env.NODE_ENV === 'production';
  const rawLanOrigin = env.LAN_HTTP_ORIGIN?.trim();
  if (production && rawLanOrigin) throw new Error('LAN_HTTP_ORIGIN is not allowed in production');

  if (production) {
    const productionOrigin = requireExactProductionHttpsOrigin(env.APP_ORIGIN);
    return {
      originAllowed: (origin) => !origin || origin === productionOrigin,
      secureCookie: true,
    };
  }

  const lanOrigin = rawLanOrigin ? requireExactLanHttpOrigin(rawLanOrigin) : undefined;
  return {
    originAllowed: (origin) => !origin || localDevelopmentOrigin.test(origin) || origin === lanOrigin,
    secureCookie: lanOrigin === undefined,
  };
}
