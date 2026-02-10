import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "SwatchWatch",
    template: "%s | SwatchWatch",
  },
  description:
    "Your smart nail polish collection manager. Catalog, search, and organize your polishes with color intelligence.",
  openGraph: {
    title: "SwatchWatch",
    description: "Your smart nail polish collection manager",
    images: [
      { url: "/og-image.png", width: 1200, height: 630, alt: "SwatchWatch" },
    ],
    type: "website",
    siteName: "SwatchWatch",
  },
  twitter: {
    card: "summary_large_image",
    title: "SwatchWatch",
    description: "Your smart nail polish collection manager",
    images: ["/og-image.png"],
  },
  icons: {
    icon: [
      { url: "/brand/swatchwatch-monogram.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/manifest.json",
  other: {
    "theme-color": "#42107e",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
