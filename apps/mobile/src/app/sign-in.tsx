import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { API_BASE_URL, DEV_USER_ID } from "@/config/env";
import { useAuth } from "@/auth/auth-provider";
import { AppText, Button, Card, ErrorBanner } from "@/components/ui";
import { useTheme } from "@/theme/theme";

/** Sign-in screen, outside the `(app)` group. One body per auth mode. */
export default function SignInScreen() {
  const { mode, signIn, busy, error } = useAuth();
  const theme = useTheme();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={{ flex: 1, justifyContent: "center", padding: theme.spacing(6), gap: theme.spacing(6) }}>
        <View style={{ alignItems: "center", gap: theme.spacing(3) }}>
          <BrandDrop />
          <AppText variant="title" accessibilityRole="header">
            SwatchWatch
          </AppText>
          <AppText muted style={{ textAlign: "center" }}>
            Your polish collection in your pocket. Scan a bottle in the aisle and know if you own it.
          </AppText>
        </View>

        {mode === "dev-bypass" && (
          <Card>
            <AppText variant="label" muted>
              Development mode
            </AppText>
            <AppText variant="small" muted>
              Signs in as dev user {DEV_USER_ID} with a `Bearer dev:{DEV_USER_ID}` token, validated by{" "}
              {API_BASE_URL}/auth/validate. Needs the local Functions host with AUTH_DEV_BYPASS=true.
            </AppText>
            <Button title="Continue as dev user" variant="brand" loading={busy} onPress={() => void signIn()} testID="dev-sign-in" />
          </Card>
        )}

        {mode === "entra" && (
          <Button title="Sign in or create account" variant="brand" loading={busy} onPress={() => void signIn()} />
        )}

        {mode === "unconfigured" && (
          <Card>
            <AppText variant="heading">Sign-in isn&apos;t configured</AppText>
            <AppText variant="small" muted>
              This build has no Entra settings. Set EXPO_PUBLIC_B2C_TENANT, EXPO_PUBLIC_B2C_TENANT_ID and
              EXPO_PUBLIC_B2C_CLIENT_ID in apps/mobile/.env.local, or EXPO_PUBLIC_AUTH_DEV_BYPASS=true for local
              development, then restart the bundler.
            </AppText>
          </Card>
        )}

        {error && <ErrorBanner message={error} />}
      </View>
    </SafeAreaView>
  );
}

/** The brand monogram's polish drop, drawn with views (no SVG dependency). */
function BrandDrop() {
  const theme = useTheme();
  return (
    <View
      style={{
        width: 72,
        height: 72,
        borderRadius: 20,
        backgroundColor: theme.colors.brand.purpleDeep,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: 17,
          borderTopLeftRadius: 2,
          transform: [{ rotate: "45deg" }],
          backgroundColor: theme.colors.brand.pink,
        }}
      />
    </View>
  );
}
