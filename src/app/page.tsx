import { redirect } from 'next/navigation';

/** The root is the admin entry point; the public surface is /c/{slug} only. */
export default function Home() {
  redirect('/dashboard');
}
