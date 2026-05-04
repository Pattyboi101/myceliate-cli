// tests/unit/queue/bashJob.test.ts
import { describe, expect, it } from 'vitest';
import { type BashJobInput, runBashJob } from '../../../src/queue/jobs/bashJob.js';

describe('runBashJob', () => {
  it('returns stdout and exit code for a successful command', async () => {
    const input: BashJobInput = { command: 'echo hello', cwd: process.cwd(), timeoutMs: 5000 };
    const result = await runBashJob(input);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.stderr).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it('returns stderr and non-zero exit code for a failing command', async () => {
    const input: BashJobInput = {
      command: 'ls /this/path/does/not/exist',
      cwd: process.cwd(),
      timeoutMs: 5000,
    };
    const result = await runBashJob(input);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it('truncates stdout if it exceeds maxBytes', async () => {
    const input: BashJobInput = {
      command: 'yes hi | head -c 200000',
      cwd: process.cwd(),
      timeoutMs: 5000,
      maxBytes: 1024,
    };
    const result = await runBashJob(input);
    expect(result.stdout.length).toBeLessThanOrEqual(1024 + 100); // small overshoot OK
    expect(result.truncated).toBe(true);
  });

  it('kills the process on timeout', async () => {
    const input: BashJobInput = { command: 'sleep 10', cwd: process.cwd(), timeoutMs: 200 };
    const result = await runBashJob(input);
    expect(result.timedOut).toBe(true);
  });

  it('captures stderr output for a command that only writes to stderr', async () => {
    const input: BashJobInput = {
      command: 'echo error-msg >&2',
      cwd: process.cwd(),
      timeoutMs: 5000,
    };
    const result = await runBashJob(input);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('error-msg');
    expect(result.exitCode).toBe(0);
  });

  it('truncates stderr if it exceeds maxBytes', async () => {
    const input: BashJobInput = {
      command: 'yes err | head -c 200000 >&2',
      cwd: process.cwd(),
      timeoutMs: 5000,
      maxBytes: 512,
    };
    const result = await runBashJob(input);
    expect(result.stderr.length).toBeLessThanOrEqual(512 + 100);
    expect(result.truncated).toBe(true);
  });

  it('resolves cleanly when spawn fails (invalid cwd)', async () => {
    // Without a child.on('error') handler this would crash the worker via uncaughtException.
    const input: BashJobInput = {
      command: 'echo hi',
      cwd: '/nonexistent/path/that/does/not/exist',
      timeoutMs: 5000,
    };
    const result = await runBashJob(input);
    expect(result.timedOut).toBe(false);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.exitCode).not.toBe(0);
  });

  it('does NOT inherit DEEPSEEK_API_KEY or other arbitrary parent env vars into the bash subprocess', async () => {
    const original = {
      key: process.env.DEEPSEEK_API_KEY,
      profile: process.env.AWS_PROFILE,
      sock: process.env.SSH_AUTH_SOCK,
    };
    process.env.DEEPSEEK_API_KEY = 'sk-fake-test-key-1234567890abcdef';
    process.env.AWS_PROFILE = 'fake-aws-profile';
    process.env.SSH_AUTH_SOCK = '/tmp/fake-ssh-sock';
    try {
      const result = await runBashJob({
        command: 'echo "K=$DEEPSEEK_API_KEY|A=$AWS_PROFILE|S=$SSH_AUTH_SOCK"',
        cwd: process.cwd(),
        timeoutMs: 5000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('K=|A=|S=');
    } finally {
      if (original.key === undefined) Reflect.deleteProperty(process.env, 'DEEPSEEK_API_KEY');
      else process.env.DEEPSEEK_API_KEY = original.key;
      if (original.profile === undefined) Reflect.deleteProperty(process.env, 'AWS_PROFILE');
      else process.env.AWS_PROFILE = original.profile;
      if (original.sock === undefined) Reflect.deleteProperty(process.env, 'SSH_AUTH_SOCK');
      else process.env.SSH_AUTH_SOCK = original.sock;
    }
  });

  it('preserves the safelisted PATH/HOME/USER/PWD/TERM in the bash subprocess', async () => {
    const result = await runBashJob({
      command: 'echo "PATH=$PATH|HOME=$HOME|USER=$USER"',
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/PATH=\S+/);
    expect(result.stdout).toMatch(/HOME=\S+/);
    expect(result.stdout).toMatch(/USER=\S+/);
  });
});
