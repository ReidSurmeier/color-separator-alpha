import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "tools.reidsurmeier.wtf",
  description: "Creative tools by Reid Surmeier",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
