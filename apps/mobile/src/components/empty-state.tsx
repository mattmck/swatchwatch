import { router, type Href } from "expo-router";
import type { ReactNode } from "react";
import { View } from "react-native";
import { ONBOARDING_ROUTES } from "@/lib/onboarding";
import { useTheme } from "@/theme/theme";
import { AppText, Button } from "./ui";

export interface EmptyStateAction {
  title: string;
  onPress: () => void;
  variant?: "primary" | "outline";
}

/**
 * A friendly empty screen: title, one sentence on what appears here, and one to three actions
 * (web: `PolishesEmptyState`). The first action is the primary one unless it says otherwise.
 */
export function EmptyState({
  title,
  message,
  actions = [],
  children,
  testID,
}: {
  title: string;
  message: string;
  actions?: EmptyStateAction[];
  children?: ReactNode;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View testID={testID} style={{ padding: theme.spacing(6), gap: theme.spacing(3), alignItems: "stretch" }}>
      <AppText variant="heading" style={{ textAlign: "center" }}>
        {title}
      </AppText>
      <AppText muted style={{ textAlign: "center" }}>
        {message}
      </AppText>
      {children}
      {actions.length > 0 && (
        <View style={{ gap: theme.spacing(2) }}>
          {actions.map((action, i) => (
            <Button
              key={action.title}
              title={action.title}
              variant={action.variant ?? (i === 0 ? "primary" : "outline")}
              onPress={action.onPress}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** Routes are plain strings (the checklist map in `lib/onboarding.ts`), so cast for typed routes. */
export function goTo(path: string) {
  router.navigate(path as Href);
}

/** The three ways to start a collection, as empty-state actions (catalog first). */
export function startCollectionActions(): EmptyStateAction[] {
  return [
    { title: "Browse the catalog", onPress: () => goTo(ONBOARDING_ROUTES.search) },
    { title: "Import a spreadsheet", onPress: () => goTo(ONBOARDING_ROUTES.import) },
    { title: "Scan a bottle", onPress: () => goTo(ONBOARDING_ROUTES.scan) },
  ];
}
