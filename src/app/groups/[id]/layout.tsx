// The group page is client-rendered from live APIs, so its HTML shell holds no
// user or group data. Generating it once per id on first request (no ids at
// build time) lets the CDN serve it instead of rendering on every request.
export function generateStaticParams() {
  return [];
}

export default function GroupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
