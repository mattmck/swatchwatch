import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/components/auth-provider";
import "./globals.css";

const metadataBase =
  process.env.NEXT_PUBLIC_SITE_URL != null
    ? new URL(process.env.NEXT_PUBLIC_SITE_URL)
    : new URL("https://swatchwatch.app");

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
  metadataBase,
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
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var p = localStorage.getItem('swatchwatch-theme');
                var d = p === 'dark' || (p === 'system' || !p) && window.matchMedia('(prefers-color-scheme: dark)').matches;
                if (d) document.documentElement.classList.add('dark');
              } catch(e) {}
            `,
          }}
        />
        <link
          rel="preload"
          href="/brand/swatchwatch-monogram.svg"
          as="image"
          type="image/svg+xml"
        />
        <link
          rel="preload"
          href="/brand/swatchwatch-lockup.svg"
          as="image"
          type="image/svg+xml"
        />
      </head>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        <AuthProvider>
          {children}
          <Toaster richColors closeButton />
        </AuthProvider>
      </body>
    </html>
  );
}
