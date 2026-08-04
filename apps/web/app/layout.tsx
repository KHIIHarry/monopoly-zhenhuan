import type { Metadata, Viewport } from 'next';
import PullToRefreshGuard from './components/pull-to-refresh-guard';
import './globals.css';

export const metadata: Metadata = {
  title: '甄嬛传e-Bank',
  applicationName: '甄嬛传e-Bank',
  description: '实体桌游数字伴侣',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icons/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/icons/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: '甄嬛传e-Bank',
    statusBarStyle: 'default',
  },
  other: {
    'apple-mobile-web-app-capable': 'yes',
  },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#ffffff' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <div id="root">{children}</div>
        <PullToRefreshGuard />
      </body>
    </html>
  );
}
