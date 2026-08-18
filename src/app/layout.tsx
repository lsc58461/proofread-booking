import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

// 차단됐을 때 404 화면이 이 레이아웃 안에서 그려진다. 여기 기본값이 남아 있으면
// 탭 제목으로 페이지의 존재가 드러나므로, 기본값을 404 쪽에 맞춰 둔다.
// 정상 동작 중에는 각 페이지가 자기 제목으로 덮어쓴다.
export const metadata: Metadata = {
  title: '404: This page could not be found.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f7f8fa',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
