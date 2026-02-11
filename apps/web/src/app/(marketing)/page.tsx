import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SwatchWatchIcon } from "@/components/brand/swatchwatch-brand";
import { ScrollFadeIn } from "@/components/scroll-fade-in";
import { CountUp } from "@/components/count-up";
import { MarketingColorShowcase } from "@/components/marketing-color-showcase";
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

const testimonials = [
  {
    quote:
      "I stopped buying accidental dupes the same month I moved my stash into SwatchWatch. The color matching is spot-on.",
    name: "Avery K.",
    handle: "@lacquerlog",
    initials: "AK",
    collectionSize: "412 shades tracked",
  },
  {
    quote:
      "The harmony suggestions save me when I plan content sets. I can build a five-color lineup in under a minute.",
    name: "Mina R.",
    handle: "@studio_mani",
    initials: "MR",
    collectionSize: "Weekly swatch creator",
  },
  {
    quote:
      "Our salon team uses it to keep inventory balanced across undertones instead of overbuying the same pink family.",
    name: "Nails by Tori",
    handle: "@nailsbytori",
    initials: "NT",
    collectionSize: "Salon inventory workflow",
  },
];

export default function LandingPage() {
  return (
    <div className="flex flex-col">
      {/* ── Hero ── */}
      <section className="relative overflow-hidden bg-gradient-hero py-16 sm:py-24 lg:py-36">
        {/* Decorative blurred circles */}
        <div
          className="pointer-events-none absolute -left-24 top-14 size-56 animate-float rounded-full opacity-30 blur-3xl sm:-left-20 sm:top-1/4 sm:size-72"
          style={{ background: "#ff4fb8" }}
        />
        <div
          className="pointer-events-none absolute -right-24 bottom-6 size-60 animate-float-slow rounded-full opacity-20 blur-3xl sm:-right-20 sm:bottom-1/4 sm:size-80"
          style={{ background: "#7b2eff" }}
        />
        <div
          className="pointer-events-none absolute left-1/2 top-6 size-28 -translate-x-1/2 animate-float-delayed rounded-full opacity-25 blur-3xl sm:top-10 sm:size-40"
          style={{ background: "#c5a6ff" }}
        />

        <div className="relative mx-auto max-w-4xl px-5 text-center sm:px-6">
          <ScrollFadeIn className="mb-6 flex justify-center sm:mb-8">
            <SwatchWatchIcon name="monogram" size={56} title="SwatchWatch" />
          </ScrollFadeIn>

          <ScrollFadeIn delay={100}>
            <h1 className="text-4xl leading-[1.03] tracking-tight sm:text-5xl lg:text-7xl xl:text-8xl">
              <span className="font-semibold text-gradient-brand">Your polish collection,</span>
              <br />
              <span className="font-black text-brand-ink">beautifully organized.</span>
            </h1>
          </ScrollFadeIn>

          <ScrollFadeIn delay={200}>
            <p className="mx-auto mt-5 max-w-2xl text-base text-brand-purple-deep/80 sm:mt-6 sm:text-lg lg:text-2xl lg:leading-relaxed">
              The smart nail polish manager that catalogs your shades, finds dupes,
              and discovers harmonious color pairings — all powered by color science.
            </p>
          </ScrollFadeIn>

          <ScrollFadeIn delay={350}>
            <div className="mt-8 flex flex-col items-center gap-3 sm:mt-10 sm:flex-row sm:justify-center sm:gap-4">
              <Button
                asChild
                size="lg"
                className="w-full bg-gradient-brand px-8 text-white shadow-glow-brand hover:opacity-90 sm:w-auto"
              >
                <Link href="/dashboard">Get Started</Link>
              </Button>
              <Button
                asChild
                variant="outline"
                size="lg"
                className="w-full border-brand-purple/30 px-8 text-brand-purple hover:bg-brand-purple/5 sm:w-auto"
              >
                <Link href="/polishes">View Collection</Link>
              </Button>
            </div>
          </ScrollFadeIn>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-5 sm:px-6">
          <ScrollFadeIn>
            <div className="text-center">
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl md:text-4xl">
                <span className="text-gradient-brand">Smart tools</span>{" "}
                for polish lovers
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground sm:mt-4 sm:text-base">
                Everything you need to manage, discover, and enjoy your nail polish
                collection.
              </p>
            </div>
          </ScrollFadeIn>

          <div className="mt-10 grid gap-4 sm:mt-16 sm:gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature, i) => (
              <ScrollFadeIn key={feature.title} delay={i * 120}>
                <div className="glass group rounded-2xl p-6 transition-shadow hover:shadow-glow-brand sm:p-8">
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
      <section className="bg-muted/50 py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-5 sm:px-6">
          <ScrollFadeIn>
            <div className="text-center">
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl md:text-4xl">
                Plan polished color stories faster
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground sm:mt-4 sm:text-base">
                Explore curated palettes, inspect harmony geometry, and watch polished
                sets assemble in real time.
              </p>
            </div>
          </ScrollFadeIn>

          <ScrollFadeIn delay={120}>
            <MarketingColorShowcase />
          </ScrollFadeIn>
        </div>
      </section>

      {/* ── Stats ── */}
      <section className="py-16 sm:py-24">
        <div className="mx-auto max-w-4xl px-5 sm:px-6">
          <ScrollFadeIn>
            <div className="text-center">
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl md:text-4xl">
                Built for <span className="text-gradient-brand">polish lovers</span>
              </h2>
            </div>
          </ScrollFadeIn>

          <div className="mt-8 grid gap-4 sm:mt-12 sm:gap-6 sm:grid-cols-3">
            {stats.map((stat, i) => (
              <ScrollFadeIn key={stat.label} delay={i * 150}>
                <div className="flex flex-col items-center rounded-2xl border border-border bg-card p-6 text-center sm:p-8">
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

      {/* ── Social Proof ── */}
      <section className="bg-muted/30 py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-5 sm:px-6">
          <ScrollFadeIn>
            <div className="text-center">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-purple/75">
                Community feedback
              </p>
              <h2 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl md:text-4xl">
                Trusted by collectors and creators
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground sm:mt-4 sm:text-base">
                Early testers use SwatchWatch to cut duplicate purchases and build
                cleaner color sets.
              </p>
            </div>
          </ScrollFadeIn>

          <div className="mt-10 grid gap-4 sm:mt-14 sm:gap-6 lg:grid-cols-3">
            {testimonials.map((testimonial, i) => (
              <ScrollFadeIn key={testimonial.name} delay={i * 130}>
                <article className="glass h-full rounded-2xl p-5 sm:p-6">
                  <p className="text-sm leading-relaxed text-foreground/90">
                    &ldquo;{testimonial.quote}&rdquo;
                  </p>
                  <div className="mt-6 flex items-center gap-3">
                    <div className="inline-flex size-10 items-center justify-center rounded-full bg-gradient-brand text-xs font-bold text-white">
                      {testimonial.initials}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">{testimonial.name}</p>
                      <p className="text-xs text-muted-foreground">{testimonial.handle}</p>
                    </div>
                  </div>
                  <p className="mt-4 text-xs font-medium uppercase tracking-[0.14em] text-brand-purple/70">
                    {testimonial.collectionSize}
                  </p>
                </article>
              </ScrollFadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="bg-gradient-hero py-16 sm:py-24">
        <ScrollFadeIn>
          <div className="mx-auto max-w-3xl px-5 text-center sm:px-6">
            <h2 className="text-2xl font-bold tracking-tight text-brand-ink sm:text-3xl md:text-4xl">
              Start organizing your collection
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm text-brand-purple-deep/70 sm:mt-4 sm:text-base">
              Join SwatchWatch and bring color intelligence to your nail polish
              collection today.
            </p>
            <div className="mt-8">
              <Button
                asChild
                size="lg"
                className="w-full bg-gradient-brand px-10 text-white shadow-glow-brand hover:opacity-90 sm:w-auto"
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
