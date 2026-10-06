import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Visibility Admin",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, background: "#f7f7f8", color: "#111" }}>{children}</body>
    </html>
  );
}
