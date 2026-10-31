import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "@/auth/auth-provider";
import { CenteredState } from "@/components/ui";
import { ThemeProvider, useTheme } from "@/theme/theme";

/**
 * Root layout. Route groups mirror the web: `(app)` holds the signed-in screens (tab bar +
 * pushed detail screens, like the web's `(app)` group behind `RequireAuth`), `sign-in` sits
 * outside it. `Stack.Protected` swaps between them as the auth status changes.
 *
 * Each guard names its `redirectTo`. Without one, expo-router falls back to the first
 * unguarded sibling by its sort order, which is `auth` (`/auth`), and that route redirects to
 * `/`, i.e. back into the guarded `(app)` group: a signed-out launch looped
 * "/auth" → "/" → "/auth" until React gave up ("Maximum update depth exceeded").
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <RootNavigator />
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function RootNavigator() {
  const { status } = useAuth();
  const theme = useTheme();

  if (status === "loading") {
    return (
      <>
        <StatusBar style="auto" />
        <CenteredState loading message="Opening your collection…" />
      </>
    );
  }

  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.background } }}>
        <Stack.Protected guard={status === "signedIn"} redirectTo="/sign-in">
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        <Stack.Protected guard={status !== "signedIn"} redirectTo="/">
          <Stack.Screen name="sign-in" />
        </Stack.Protected>
      </Stack>
    </>
  );
}
