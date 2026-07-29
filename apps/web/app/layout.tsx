import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = { title: '甄嬛传大富翁', description: '实体桌游数字伴侣' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#ffffff' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
