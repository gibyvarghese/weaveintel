/**
 * tool-call-line.tsx — a collapsed one-line summary of a tool invocation.
 *
 * Device-gated. Tool calls during a run render as compact monospace lines
 * (e.g. `⚙ web.search · running` / `✓ web.search`) rather than full cards, so
 * the assistant's prose stays the focus. Tapping is a no-op for M4; a detail
 * sheet arrives with the widget surface (M5).
 */
import { Text } from 'react-native';
import type { ToolCallView } from '@geneweave/api-client';
import { useTheme } from '../../providers/theme-provider';

export function ToolCallLine({ call }: { call: ToolCallView }) {
  const { theme } = useTheme();
  const glyph = call.error ? '\u2715' : call.result !== undefined ? '\u2713' : '\u2699';
  const status = call.error ? 'failed' : call.result !== undefined ? 'done' : 'running';
  const color = call.error ? theme.colors.danger : theme.colors.textSecondary;
  return (
    <Text
      style={{
        fontFamily: theme.typography.families.mono,
        fontSize: theme.typography.scale.mono.fontSize,
        lineHeight: theme.typography.scale.mono.lineHeight,
        color,
      }}
      numberOfLines={1}
    >
      {glyph} {call.toolName} · {status}
    </Text>
  );
}
