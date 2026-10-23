import { Stack } from "expo-router";
import { useTheme } from "@/theme/theme";

/** Signed-in area: the tab bar plus screens pushed over it (polish detail, Add a polish, Match). */
export default function AppLayout() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.card },
        headerTintColor: theme.colors.primary,
        headerTitleStyle: { color: theme.colors.foreground },
        contentStyle: { backgroundColor: theme.colors.background },
        headerBackButtonDisplayMode: "minimal",
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="polishes/[id]" options={{ title: "Polish" }} />
      <Stack.Screen name="polishes/new" options={{ title: "Add a polish" }} />
      <Stack.Screen name="looks" options={{ title: "Looks" }} />
      <Stack.Screen name="gaps" options={{ title: "Collection gaps" }} />
      <Stack.Screen name="match" options={{ title: "Match to collection" }} />
      <Stack.Screen name="insights" options={{ title: "Insights" }} />
    </Stack>
  );
}
