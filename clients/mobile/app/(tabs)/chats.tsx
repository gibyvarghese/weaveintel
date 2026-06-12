/**
 * (tabs)/chats.tsx — conversation history (placeholder).
 *
 * The conversation list (consuming `listConversations` / `updateConversation`)
 * is built in a later milestone; M3 ships the navigation shell.
 */
import { Screen, Heading, Body } from '../../src/native/ui/primitives';

export default function ChatsScreen() {
  return (
    <Screen>
      <Heading>Chats</Heading>
      <Body muted>Past conversations will appear here.</Body>
    </Screen>
  );
}
