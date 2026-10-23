import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { ScrollView, View } from "react-native";
import { API_BASE_URL } from "@/config/env";
import { useAuth } from "@/auth/auth-provider";
import { ExportCollectionCard } from "@/components/export-collection";
import { AppText, Button, Card } from "@/components/ui";
import { useTheme } from "@/theme/theme";

const MODE_LABELS = {
  "dev-bypass": "Dev bypass (Bearer dev:<id>)",
  entra: "Microsoft Entra External ID",
  unconfigured: "Not configured",
} as const;

export default function ProfileScreen() {
  const { user, mode, signOut } = useAuth();
  const theme = useTheme();
  const router = useRouter();

  return (
    <ScrollView contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(4) }}>
      <Card>
        <AppText variant="label" muted>
          Signed in as
        </AppText>
        <AppText variant="heading" testID="profile-name">
          {user?.name ?? "—"}
        </AppText>
        {user?.email ? <AppText muted>{user.email}</AppText> : null}
        <Row label="User id" value={user ? String(user.userId) : "—"} />
        <Row label="Role" value={user?.role ?? "—"} />
      </Card>

      <Card>
        <AppText variant="label" muted>
          Connection
        </AppText>
        <Row label="API" value={API_BASE_URL} />
        <Row label="Sign-in" value={MODE_LABELS[mode]} />
        <Row label="App version" value={Constants.expoConfig?.version ?? "dev"} />
      </Card>

      <Card>
        <AppText variant="label" muted>
          Import
        </AppText>
        <AppText variant="small" muted>
          Bring in a spreadsheet of your polishes as a CSV file.
        </AppText>
        <Button title="Import from CSV" variant="outline" onPress={() => router.push("/import")} testID="profile-import" />
      </Card>

      <ExportCollectionCard />

      <Button title="Sign out" variant="outline" onPress={() => void signOut()} />
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.spacing(3) }}>
      <AppText variant="small" muted>
        {label}
      </AppText>
      <AppText variant="small" style={{ flexShrink: 1, textAlign: "right" }} selectable>
        {value}
      </AppText>
    </View>
  );
}
