/**
 * (tabs) group layout — the primary authenticated navigation.
 *
 * Four tabs: Chat (the home surface), Chats (conversation history), Actions
 * (tasks + reminders), and Profile. M3 ships the navigation shell + theming;
 * the feature content of each tab lands in later milestones (M4+). The tab bar
 * is themed from `@geneweave/tokens` via {@link useTheme}.
 */
import { Tabs } from 'expo-router';
import { useTheme } from '../../src/native/providers';

export default function TabsLayout() {
  const { theme } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.surfaceElevated,
        },
        tabBarLabelStyle: { fontFamily: theme.typography.families.body },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Chat' }} />
      <Tabs.Screen name="chats" options={{ title: 'Chats' }} />
      <Tabs.Screen name="actions" options={{ title: 'Actions' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
    </Tabs>
  );
}
