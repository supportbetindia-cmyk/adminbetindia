import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BetIndia Smart Link Manager',
  description: 'Campaign attribution and link management',
  // The admin surface must never be indexed, and neither must the redirect
  // endpoint (which sets its own header).
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/*
          Poppins for headings and Inter for body, per UI/UX §2. Loaded by
          <link> rather than next/font so the build does not require network
          access; the CSS stack falls back to system fonts if the request
          fails, which §2 explicitly permits.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@500;600;700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
