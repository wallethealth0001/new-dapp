import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crypto Transfer Screen",
  description: "Enter a USDT transfer amount.",
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
