import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const appDirectory = fileURLToPath(new URL('.', import.meta.url));
const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));

async function readPngHeader(path: string) {
  const image = await readFile(path);
  const signature = image.subarray(0, 8);
  const expectedSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  if (!signature.equals(expectedSignature) || image.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error(`${path} is not a valid PNG with an IHDR header`);
  }

  return {
    width: image.readUInt32BE(16),
    height: image.readUInt32BE(20),
    colorType: image[25],
  };
}

describe('PWA metadata', () => {
  test('defines one complete App Router manifest', async () => {
    const manifestPath = fileURLToPath(new URL('./manifest.ts', import.meta.url));

    expect(existsSync(manifestPath)).toBe(true);

    const { default: createManifest } = await import('./manifest');

    expect(createManifest()).toEqual({
      name: '甄嬛传e-Bank',
      short_name: '甄嬛传e-Bank',
      description: '实体桌游数字伴侣',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      theme_color: '#ffffff',
      background_color: '#ffffff',
      icons: [
        {
          src: '/icons/icon-192x192.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any',
        },
        {
          src: '/icons/icon-512x512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any',
        },
      ],
    });
  });

  test('declares browser and Safari metadata through the root layout', async () => {
    const layout = await readFile(`${appDirectory}/layout.tsx`, 'utf8');

    expect(layout).toContain("title: '甄嬛传e-Bank'");
    expect(layout).toContain("applicationName: '甄嬛传e-Bank'");
    expect(layout).toContain("manifest: '/manifest.webmanifest'");
    expect(layout).toContain("title: '甄嬛传e-Bank'");
    expect(layout).toContain('capable: true');
    expect(layout).toContain("statusBarStyle: 'default'");
    expect(layout).toContain("'apple-mobile-web-app-capable': 'yes'");
    expect(layout).toContain("url: '/icons/apple-touch-icon.png'");
    expect(layout).toContain("sizes: '180x180'");
  });

  test.each([
    ['icons/favicon-16x16.png', 16],
    ['icons/favicon-32x32.png', 32],
    ['icons/apple-touch-icon.png', 180],
    ['icons/icon-192x192.png', 192],
    ['icons/icon-512x512.png', 512],
  ])('provides %s as a square PNG', async (relativePath, size) => {
    const iconPath = `${publicDirectory}/${relativePath}`;

    expect(existsSync(iconPath)).toBe(true);

    const metadata = await readPngHeader(iconPath);

    expect(metadata.width).toBe(size);
    expect(metadata.height).toBe(size);
  });

  test('provides an opaque Apple touch icon for iOS home screens', async () => {
    const metadata = await readPngHeader(`${publicDirectory}/icons/apple-touch-icon.png`);

    expect(metadata.colorType).toBe(2);
  });
});
