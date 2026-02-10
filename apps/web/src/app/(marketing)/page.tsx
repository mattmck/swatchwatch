import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SwatchWatchIcon } from "@/components/brand/swatchwatch-brand";
import { ScrollFadeIn } from "@/components/scroll-fade-in";
import { CountUp } from "@/components/count-up";
import { Palette, Camera, LayoutGrid, Sparkles, Search, Droplets } from "lucide-react";

const features = [
  {
    icon: Palette,
    title: "Color Intelligence",
    description:
      "Search your collection by color. Find similar shades, complementary matches, and harmonious palettes using perceptual OKLAB color science.",
  },
  {
    icon: Camera,
    title: "Smart Capture",
    description:
      "Snap a photo of any polish bottle. Our AI reads the label, identifies the shade, and adds it to your collection automatically.",
  },
  {
    icon: LayoutGrid,
    title: "Organize Everything",
    description:
      "Track brands, finishes, collections, and ratings. Filter and sort your entire collection in seconds.",
  },
];

const stats = [
  { value: "500+", label: "Shades cataloged", icon: Droplets },
  { value: "7", label: "Color harmonies", icon: Sparkles },
  { value: "Instant", label: "Dupe detection", icon: Search },
];

const showcaseColors = [
  { name: "Berry Kiss", hex: "#c51d93", finish: "Shimmer" },
  { name: "Lilac Dream", hex: "#c5a6ff", finish: "Cream" },
  { name: "Hot Fuchsia", hex: "#ff4fb8", finish: "Glitter" },
  { name: "Midnight Plum", hex: "#42107e", finish: "Cream" },
  { name: "Rose Quartz", hex: "#ffb3e3", finish: "Shimmer" },
  { name: "Ultra Violet", hex: "#7b2eff", finish: "Matte" },
];

export default function LandingPage() {
  return (
    <div className="flex flex-col">
      {/* ── Hero ── */}
      <section className="relative overflow-hidden bg-gradient-hero py-24 sm:py-32 lg:py-40">
        {/* Decorative blurred circles */}
        <div
          className="pointer-events-none absolute -left-20 top-1/4 size-72 animate-float rounded-full opacity-30 blur-3xl"
          style={{ background: "#ff4fb8" }}
        />
        <div
          className="pointer-events-none absolute -right-20 bottom-1/4 size-80 animate-float-slow rounded-full opacity-20 blur-3xl"
          style={{ background: "#7b2eff" }}
        />
        <div
          className="pointer-events-none absolute left-1/2 top-10 size-40 -translate-x-1/2 animate-float-delayed rounded-full opacity-25 blur-3xl"
          style={{ background: "#c5a6ff" }}
        />

        <div className="relative mx-auto max-w-4xl px-6 text-center">
          <div className="mb-8 flex justify-center animate-fade-in-up">
            <SwatchWatchIcon name="monogram" size={80} title="SwatchWatch" />
          </div>

          <h1 className="text-5xl tracking-tight sm:text-6xl lg:text-7xl animate-fade-in-up" style={{ animationDelay: "100ms" }}>
            <span className="font-medium text-gradient-brand">Your polish collection,</span>
            <br />
            <span className="font-extrabold text-brand-ink">beautifully organized.</span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-lg text-brand-purple-deep/80 sm:text-xl lg:text-2xl lg:leading-relaxed animate-fade-in-up" style={{ animationDelay: "200ms" }}>
            The smart nail polish manager that catalogs your shades, finds dupes,
            and discovers harmonious color pairings — all powered by color science.
          </p>

          <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center animate-fade-in-up" style={{ animationDelay: "350ms" }}>
            <Button
              asChild
              size="lg"
              className="bg-gradient-brand px-8 text-white shadow-glow-brand hover:opacity-90"
            >
              <Link href="/dashboard">Get Started</Link>
            </Button>
            <Button
              asChild
              variant="outline"
              size="lg"
              className="border-brand-purple/30 px-8 text-brand-purple hover:bg-brand-purple/5"
            >
              <Link href="/polishes">View Collection</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="py-20 sm:py-28">
        <div className="mx-auto max-w-6xl px-6">
          <ScrollFadeIn>
            <div className="text-center">
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
                <span className="text-gradient-brand">Smart tools</span>{" "}
                for polish lovers
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
                Everything you need to manage, discover, and enjoy your nail polish
                collection.
              </p>
            </div>
          </ScrollFadeIn>

          <div className="mt-16 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature, i) => (
              <ScrollFadeIn key={feature.title} delay={i * 120}>
                <div className="glass group rounded-2xl p-8 transition-shadow hover:shadow-glow-brand">
                  <div className="mb-4 inline-flex size-12 items-center justify-center rounded-xl bg-gradient-brand text-white">
                    <feature.icon className="size-6" />
                  </div>
                  <h3 className="mb-2 text-lg font-semibold text-foreground">
                    {feature.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {feature.description}
                  </p>
                </div>
              </ScrollFadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ── Color Showcase ── */}
      <section className="bg-muted/50 py-20 sm:py-28">
        <div className="mx-auto max-w-6xl px-6">
          <ScrollFadeIn>
            <div className="text-center">
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
                See every shade at a glance
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
                Rich polish cards with color intelligence, finish types, and visual
                harmony suggestions.
              </p>
            </div>
          </ScrollFadeIn>

          <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {showcaseColors.map((color, i) => (
              <ScrollFadeIn key={color.name} delay={i * 80}>
                <div className="group flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition-shadow hover:shadow-glow-brand">
                  <div
                    className="size-14 shrink-0 rounded-lg shadow-sm ring-1 ring-black/5"
                    style={{ backgroundColor: color.hex }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-foreground">{color.name}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                        {color.finish}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {color.hex}
                      </span>
                    </div>
                  </div>
                </div>
              </ScrollFadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ── Stats ── */}
      <section className="py-20 sm:py-28">
        <div className="mx-auto max-w-4xl px-6">
          <ScrollFadeIn>
            <div className="text-center">
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
                Built for <span className="text-gradient-brand">polish lovers</span>
              </h2>
            </div>
          </ScrollFadeIn>

          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            {stats.map((stat, i) => (
              <ScrollFadeIn key={stat.label} delay={i * 150}>
                <div className="flex flex-col items-center rounded-2xl border border-border bg-card p-8 text-center">
                  <div className="mb-3 inline-flex size-10 items-center justify-center rounded-lg bg-accent">
                    <stat.icon className="size-5 text-accent-foreground" />
                  </div>
                  <p className="text-3xl font-extrabold text-gradient-brand">
                    <CountUp value={stat.value} />
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {stat.label}
                  </p>
                </div>
              </ScrollFadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="bg-gradient-hero py-20 sm:py-28">
        <ScrollFadeIn>
          <div className="mx-auto max-w-3xl px-6 text-center">
            <h2 className="text-3xl font-bold tracking-tight text-brand-ink sm:text-4xl">
              Start organizing your collection
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-brand-purple-deep/70">
              Join SwatchWatch and bring color intelligence to your nail polish
              collection today.
            </p>
            <div className="mt-8">
              <Button
                asChild
                size="lg"
                className="bg-gradient-brand px-10 text-white shadow-glow-brand hover:opacity-90"
              >
                <Link href="/dashboard">Get Started Free</Link>
              </Button>
            </div>
          </div>
        </ScrollFadeIn>
      </section>
    </div>
  );
}
