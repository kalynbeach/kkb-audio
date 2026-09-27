"use client";
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <main className="message-page"><h1>This page could not load</h1><p>Try opening it again. Any audio session on this page has ended.</p><button className="action-button" onClick={reset}>Try again</button><a className="text-link" href="/">Back to overview</a></main>; }
