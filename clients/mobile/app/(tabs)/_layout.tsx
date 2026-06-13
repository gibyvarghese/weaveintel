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
import { Icon } from '../../src/native/ui/icon';

export default function TabsLayout() {
  const { theme } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // Active = accent (the one sanctioned accent use for tab indication);
        // inactive = secondary text per the monochrome icon rules.
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textSecondary,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.surfaceElevated,
        },
        tabBarLabelStyle: { fontFamily: theme.typography.families.body },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Chat', tabBarIcon: ({ color }) => <Icon name="chat" size="lg" color={color} /> }}
      />
      <Tabs.Screen
        name="chats"
        options={{ title: 'Chats', tabBarIcon: ({ color }) => <Icon name="chats" size="lg" color={color} /> }}
      />
      <Tabs.Screen
        name="actions"
        options={{ title: 'Actions', tabBarIcon: ({ color }) => <Icon name="actions" size="lg" color={color} /> }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: 'Profile', tabBarIcon: ({ color }) => <Icon name="profile" size="lg" color={color} /> }}
      />
    </Tabs>
  );
}
