import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
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
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        {children}
        <Toaster richColors closeButton />
      </body>
    </html>
  );
}
