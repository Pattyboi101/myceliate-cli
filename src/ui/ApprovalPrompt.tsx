// src/ui/ApprovalPrompt.tsx
import { Box, Text, useInput } from 'ink';
import React from 'react';
import type { ApprovalRequest, ApprovalResponse } from '../security/hitlGate.js';

export function ApprovalPrompt({ request, onResponse }: { request: ApprovalRequest; onResponse: (r: ApprovalResponse) => void }): React.JSX.Element {
  useInput((input) => {
    if (input === 'y' || input === 'Y') onResponse({ decision: 'approve' });
    else if (input === 'n' || input === 'N') onResponse({ decision: 'reject' });
  });
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">⚠ Approval required</Text>
      <Text>Command: <Text bold>{request.command}</Text></Text>
      <Text>Cwd: {request.cwd}</Text>
      <Text>Reason: {request.reason}</Text>
      <Text dimColor>Press Y to approve, N to reject.</Text>
    </Box>
  );
}
