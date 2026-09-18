import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Pendulum Lab — 균형을 만드는 판단',
  description: '단일·이중 역진자와 Jev AI의 판단을 탐구하는 물리 실험실.',
  metadataBase: new URL('https://pendulum-jev-lab.genial-peony-3958.chatgpt.site'),
  icons: { icon: '/favicon.svg' },
  openGraph: {
    title: 'Pendulum Lab — 균형을 만드는 판단',
    description: '보조 제어 없이, Jev 단일·다층 판단 네트워크로 역진자를 세우는 실험.',
    type: 'website',
    locale: 'ko_KR',
    images: [{ url: 'https://pendulum-jev-lab.genial-peony-3958.chatgpt.site/og.png', width: 1731, height: 909, alt: 'PENDULUM / LAB — CONTROL INTELLIGENCE' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Pendulum Lab — 균형을 만드는 판단',
    description: '단일·이중 역진자와 Jev 판단 네트워크 실험.',
    images: ['https://pendulum-jev-lab.genial-peony-3958.chatgpt.site/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
