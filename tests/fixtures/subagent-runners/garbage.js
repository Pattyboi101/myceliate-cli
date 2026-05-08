// Fixture: writes invalid JSON to stdout and exits 0.
process.stdout.write('not json\n');
process.exit(0);
