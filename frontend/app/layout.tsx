import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "USDT Verify | Allowance Spending", description: "BEP-20 USDT allowance security and execution dashboard." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }