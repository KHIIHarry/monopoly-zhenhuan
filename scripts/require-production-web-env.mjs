const rawApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();

if (!rawApiUrl) {
  console.error('NEXT_PUBLIC_API_URL is required for a production Web build');
  process.exit(1);
}

let apiUrl;
try {
  apiUrl = new URL(rawApiUrl);
} catch {
  console.error('NEXT_PUBLIC_API_URL must be a valid absolute URL');
  process.exit(1);
}

const hostname = apiUrl.hostname.toLowerCase();
const loopback = hostname === 'localhost'
  || hostname === '::1'
  || hostname === '[::1]'
  || hostname === '0.0.0.0'
  || hostname.startsWith('127.');

if (!['http:', 'https:'].includes(apiUrl.protocol) || loopback) {
  console.error('NEXT_PUBLIC_API_URL must be a non-loopback HTTP(S) URL for production clients');
  process.exit(1);
}
