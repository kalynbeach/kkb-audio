import Link from "next/link";
export default function NotFound() { return <main className="message-page"><h1>Page not found</h1><p>Choose a destination from the navigation or return to the overview.</p><Link className="text-link" href="/">Back to overview</Link></main>; }
