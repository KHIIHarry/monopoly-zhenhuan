const preferredInterfaceNames = new Set(['en0', 'wlan0', 'wi-fi']);

export function isPrivateIpv4(value) {
  const octets = value.split('.');
  if (octets.length !== 4) return false;
  if (octets.some((part) => !/^\d+$/.test(part) || Number(part) > 255 || String(Number(part)) !== part)) return false;
  const [first, second] = octets.map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function unique(values) {
  return [...new Set(values)];
}

export function resolveLanHost({ override, interfaces = {} } = {}) {
  const explicitHost = typeof override === 'string' ? override.trim() : '';
  if (explicitHost) {
    if (!isPrivateIpv4(explicitHost)) throw new Error('LAN_HOST must be an RFC1918 private IPv4 address');
    return explicitHost;
  }

  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter((entry) => (entry.family === 'IPv4' || entry.family === 4) && !entry.internal && isPrivateIpv4(entry.address))
      .map((entry) => ({ name: name.toLowerCase(), address: entry.address })),
  );
  const preferred = unique(candidates.filter((entry) => preferredInterfaceNames.has(entry.name)).map((entry) => entry.address));
  if (preferred.length === 1) return preferred[0];
  if (preferred.length > 1) throw new Error('Multiple Wi-Fi private IPv4 addresses found; set LAN_HOST explicitly');

  const remaining = unique(candidates.map((entry) => entry.address));
  if (remaining.length === 1) return remaining[0];
  if (remaining.length === 0) throw new Error('No private IPv4 address found; connect to Wi-Fi or set LAN_HOST explicitly');
  throw new Error('Multiple private IPv4 addresses found; set LAN_HOST explicitly');
}

export function buildLanEnvironment(host) {
  if (!isPrivateIpv4(host)) throw new Error('LAN_HOST must be an RFC1918 private IPv4 address');
  return {
    LAN_HTTP_ORIGIN: `http://${host}:3000`,
    NEXT_PUBLIC_API_URL: `http://${host}:4000`,
    NEXT_ALLOWED_DEV_ORIGINS: host,
  };
}
