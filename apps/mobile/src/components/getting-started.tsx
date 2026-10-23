import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import {
  GETTING_STARTED_STEPS,
  ONBOARDING_GOAL,
  dismissGettingStarted,
  gettingStartedView,
  markGettingStartedStarted,
  markStepVisited,
  onboardingProgress,
  parseGettingStartedState,
  serializeGettingStartedState,
  type GettingStartedState,
  type GettingStartedStepId,
  type Polish,
} from "swatchwatch-shared";
import { cacheStorageKey } from "@/lib/api-cache";
import { GETTING_STARTED_CACHE_KEY, ONBOARDING_ROUTES, swatchStripHexes } from "@/lib/onboarding";
import { useTheme } from "@/theme/theme";
import { goTo } from "./empty-state";
import { AppText, Button, Card } from "./ui";

const STEP_COPY: Record<GettingStartedStepId, string> = {
  import: "Bring a CSV from Google Sheets, Notion or another polish app.",
  scan: "Point your camera at the barcode or label.",
  search: "Find shades by brand or name and add them in a tap.",
};

/**
 * First-run checklist at the top of Home (web: `GettingStarted`): shown while the user owns
 * fewer than 5 polishes, then until 20 once started. Per-user state (started / dismissed /
 * opened steps) lives in AsyncStorage under the per-user cache prefix, so sign-out wipes it
 * (no expiry, unlike cached API data).
 */
export function GettingStarted({
  scope,
  ownedCount,
  owned,
}: {
  /** Internal user id; null while signed out (renders nothing). */
  scope: string | null;
  ownedCount: number;
  owned: readonly Polish[];
}) {
  const theme = useTheme();
  const [state, setState] = useState<GettingStartedState | null>(null);
  const storageKey = scope ? cacheStorageKey(scope, GETTING_STARTED_CACHE_KEY) : null;

  useEffect(() => {
    if (!storageKey) return;
    let cancelled = false;
    AsyncStorage.getItem(storageKey)
      .catch(() => null)
      .then((raw) => {
        if (!cancelled) setState(parseGettingStartedState(raw));
      });
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  const save = useCallback(
    (next: GettingStartedState) => {
      setState(next);
      if (storageKey) void AsyncStorage.setItem(storageKey, serializeGettingStartedState(next)).catch(() => undefined);
    },
    [storageKey],
  );

  // "Started" is derived (shown while < 5 owned); persist it so progress stays visible past 5.
  const current = state ? markGettingStartedStarted(state, ownedCount) : null;
  const shouldPersist = state !== null && current !== state;
  useEffect(() => {
    if (shouldPersist && current && storageKey) {
      void AsyncStorage.setItem(storageKey, serializeGettingStartedState(current)).catch(() => undefined);
    }
  }, [shouldPersist, current, storageKey]);

  if (!state || !current) return null;
  const view = gettingStartedView(ownedCount, current);
  if (view === "hidden") return null;

  const progress = onboardingProgress(ownedCount);
  const complete = view === "complete";
  const hexes = swatchStripHexes(owned);

  return (
    <Card testID="getting-started">
      <AppText variant="heading">{complete ? "Your collection is set up" : "Build your collection"}</AppText>
      <AppText variant="small" muted>
        {complete
          ? "Insights, the gap map and Pick for me now have enough to work with."
          : `Add your first ${ONBOARDING_GOAL} polishes and the rest of SwatchWatch comes alive.`}
      </AppText>

      <View
        accessibilityRole="progressbar"
        accessibilityLabel="Polishes added"
        accessibilityValue={{ min: 0, max: ONBOARDING_GOAL, now: progress.count, text: progress.label }}
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}
      >
        {Array.from({ length: ONBOARDING_GOAL }, (_, i) => {
          const filled = i < progress.count;
          return (
            <View
              key={i}
              style={{
                width: 12,
                height: 16,
                borderTopLeftRadius: 6,
                borderTopRightRadius: 6,
                borderBottomLeftRadius: 2,
                borderBottomRightRadius: 2,
                backgroundColor: filled ? (hexes[i] ?? theme.colors.primary) : "transparent",
                borderWidth: 1,
                borderStyle: filled ? "solid" : "dashed",
                borderColor: filled ? "rgba(0,0,0,0.15)" : theme.colors.border,
              }}
            />
          );
        })}
      </View>
      <AppText variant="small" style={{ fontWeight: "600" }}>
        {progress.label}
      </AppText>

      {complete ? (
        <Button title="Done" onPress={() => save(dismissGettingStarted(current))} testID="getting-started-done" />
      ) : (
        <>
          <View style={{ gap: theme.spacing(2) }}>
            {GETTING_STARTED_STEPS.map((step) => {
              const visited = current.visited.includes(step.id);
              return (
                <View key={step.id} style={{ gap: 2 }}>
                  <Button
                    title={`${visited ? "✓ " : ""}${step.label}`}
                    variant={visited ? "outline" : "primary"}
                    compact
                    accessibilityLabel={`${step.label}. ${STEP_COPY[step.id]}${visited ? " Opened before." : ""}`}
                    onPress={() => {
                      save(markStepVisited(current, step.id));
                      goTo(ONBOARDING_ROUTES[step.id]);
                    }}
                    testID={`getting-started-${step.id}`}
                  />
                  <AppText variant="tiny" muted>
                    {STEP_COPY[step.id]}
                  </AppText>
                </View>
              );
            })}
          </View>
          <Button
            title="Dismiss"
            variant="outline"
            compact
            onPress={() => save(dismissGettingStarted(current))}
            testID="getting-started-dismiss"
          />
        </>
      )}
    </Card>
  );
}
