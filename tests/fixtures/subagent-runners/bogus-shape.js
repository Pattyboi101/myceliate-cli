// Fixture: writes a JSON object with the wrong shape (Zod should reject it).
process.stdout.write(`${JSON.stringify({ random: 'fields' })}\n`);
process.exit(0);
