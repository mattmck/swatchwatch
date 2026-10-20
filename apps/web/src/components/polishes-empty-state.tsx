"use client";

import { Archive, Droplets, Heart, SearchX } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { trackOnboardingStepClicked } from "@/lib/metrics-events";
import { GETTING_STARTED_STEPS, type PolishesEmptyStateKind } from "@/lib/onboarding";

const IMPORT_HREF = GETTING_STARTED_STEPS.find((step) => step.id === "import")?.href ?? "/polishes/import";

/**
 * Empty `/polishes` table: says what the current view will hold and offers the one action that
 * fills it. "Browse the catalog" stays on the page (switches to All and focuses the search box).
 */
export function PolishesEmptyState({
  kind,
  onBrowseCatalog,
  onClearFilters,
}: {
  kind: PolishesEmptyStateKind;
  /** Switch to every polish (All) and focus the search box. */
  onBrowseCatalog: () => void;
  onClearFilters: () => void;
}) {
  // Only the empty collection is an onboarding step (the user owns nothing there).
  const browse = () => {
    trackOnboardingStepClicked({ step: "search", surface: "polishes_empty", ownedCount: 0 });
    onBrowseCatalog();
  };

  switch (kind) {
    case "collection":
      return (
        <EmptyState
          icon={Droplets}
          title="Your collection starts here"
          description="Polishes you own show up here, ready to sort, filter and log when you wear them."
          actionLabel="Browse the catalog"
          onAction={browse}
          secondaryAction={{
            label: "Import",
            href: IMPORT_HREF,
            onClick: () => trackOnboardingStepClicked({ step: "import", surface: "polishes_empty", ownedCount: 0 }),
          }}
        />
      );
    case "wishlist":
      return (
        <EmptyState
          icon={Heart}
          title="Nothing on your wishlist yet"
          description="Tap the heart on any polish in the catalog to keep it here for later."
          actionLabel="Browse the catalog"
          onAction={onBrowseCatalog}
        />
      );
    case "status":
      return (
        <EmptyState
          icon={Archive}
          title="No polishes with this status"
          description="Polishes you destash or archive from your collection land here."
          actionLabel="Show every polish"
          onAction={onBrowseCatalog}
        />
      );
    case "filtered":
      return (
        <EmptyState
          icon={SearchX}
          title="No matches"
          description="Nothing fits these filters. Clear them to see more."
          actionLabel="Clear filters"
          onAction={onClearFilters}
        />
      );
    case "catalog":
      return (
        <EmptyState
          title="No polishes yet"
          description="The catalog is empty right now. Add the first polish yourself."
          actionLabel="+ Add Polish"
          actionHref="/polishes/new"
        />
      );
  }
}
