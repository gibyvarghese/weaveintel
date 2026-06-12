/**
 * (tabs)/actions.tsx — tasks + reminders (placeholder).
 *
 * The task list and reminder scheduling (consuming `listTasks` / `createTask`
 * and `listReminders` / `createReminder`) land in a later milestone; M3 ships
 * the navigation shell.
 */
import { Screen, Heading, Body } from '../../src/native/ui/primitives';

export default function ActionsScreen() {
  return (
    <Screen>
      <Heading>Actions</Heading>
      <Body muted>Tasks and reminders from your conversations will appear here.</Body>
    </Screen>
  );
}
