import Ionicons from "@expo/vector-icons/Ionicons";
import { Tabs } from "expo-router";
import type { ComponentProps } from "react";
import type { ColorValue } from "react-native";
import { useTheme } from "@/theme/theme";

type IconName = ComponentProps<typeof Ionicons>["name"];

function tabIcon(name: IconName, focusedName: IconName) {
  function TabIcon({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) {
    return <Ionicons name={focused ? focusedName : name} size={size} color={color as string} />;
  }
  return TabIcon;
}

/** Tab bar: Collection / Search / Add (Rapid Add camera) / Profile. */
export default function TabsLayout() {
  const theme = useTheme();
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.mutedForeground,
        tabBarStyle: { backgroundColor: theme.colors.card, borderTopColor: theme.colors.border },
        headerStyle: { backgroundColor: theme.colors.card },
        headerTitleStyle: { color: theme.colors.foreground },
        sceneStyle: { backgroundColor: theme.colors.background },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: "Collection", tabBarIcon: tabIcon("color-palette-outline", "color-palette") }}
      />
      <Tabs.Screen name="search" options={{ title: "Search", tabBarIcon: tabIcon("search-outline", "search") }} />
      <Tabs.Screen
        name="add"
        options={{ title: "Rapid Add", tabBarLabel: "Add", tabBarIcon: tabIcon("scan-outline", "scan") }}
      />
      <Tabs.Screen
        name="manis"
        options={{ title: "Mani log", tabBarLabel: "Manis", tabBarIcon: tabIcon("calendar-outline", "calendar") }}
      />
      <Tabs.Screen name="profile" options={{ title: "Profile", tabBarIcon: tabIcon("person-outline", "person") }} />
    </Tabs>
  );
}
