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
    /*
      Poppins for headings and Inter for body, per UI/UX §2 — declared with
      @font-face in globals.css and served from /public/fonts.

      There is deliberately no <link> to fonts.googleapis.com here. Next
      optimizes such links by fetching the stylesheet server-side at render
      time, which throws `TypeError: fetch failed` on every render if the host
      cannot reach Google. Self-hosting removes the failure mode and the
      third-party request together.
    */
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
