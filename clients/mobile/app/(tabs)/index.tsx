/**
 * (tabs)/index.tsx — Chat home surface (placeholder).
 *
 * M3 establishes the tab + theming; the live chat composer and streaming run
 * view (consuming `@geneweave/api-client` `startRun` / `attachRun` and the
 * SP3 server fan-out) arrive in M4.
 */
import { Screen, Heading, Body } from '../../src/native/ui/primitives';

export default function ChatScreen() {
  return (
    <Screen>
      <Heading>Chat</Heading>
      <Body muted>Your conversation with geneWeave starts here. Live runs arrive in M4.</Body>
    </Screen>
  );
}
