// src/ui/ApprovalPrompt.tsx
import { Box, Text, useInput } from 'ink';
import { useRef } from 'react';
import type React from 'react';
import type { ApprovalRequest, ApprovalResponse } from '../security/hitlGate.js';

export function ApprovalPrompt({
  request,
  onResponse,
}: { request: ApprovalRequest; onResponse: (r: ApprovalResponse) => void }): React.JSX.Element {
  // Guard against double-fire: useInput may receive multiple keypresses before
  // React unmounts us. The HitlGate Promise drops second resolves, but the
  // "exactly once per mount" contract must hold at the component layer too.
  const firedRef = useRef(false);
  useInput((input) => {
    if (firedRef.current) return;
    if (input === 'y' || input === 'Y') {
      firedRef.current = true;
      onResponse({ decision: 'approve' });
    } else if (input === 'n' || input === 'N') {
      firedRef.current = true;
      onResponse({ decision: 'reject' });
    }
  });
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        ⚠ Approval required
      </Text>
      <Text>
        Command: <Text bold>{request.command}</Text>
      </Text>
      <Text>Cwd: {request.cwd}</Text>
      <Text>Reason: {request.reason}</Text>
      <Text dimColor>Press Y to approve, N to reject.</Text>
    </Box>
  );
}
