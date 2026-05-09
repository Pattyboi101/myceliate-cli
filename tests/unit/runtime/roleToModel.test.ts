// tests/unit/runtime/roleToModel.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type SporeRole,
  checkAndWarnEnvOverride,
  roleToModel,
} from '../../../src/runtime/roleToModel.js';

const ROLES: SporeRole[] = [
  'subagent',
  'repl-execution',
  'repl-with-reasoning',
  'germination',
  'orchestrator',
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('roleToModel — canonical mapping', () => {
  it('routes subagent + repl-execution to V4-Flash (Anamorph)', () => {
    vi.stubEnv('DEEPSEEK_MODEL', '');
    expect(roleToModel('subagent')).toBe('deepseek-v4-flash');
    expect(roleToModel('repl-execution')).toBe('deepseek-v4-flash');
  });

  it('routes repl-with-reasoning + germination + orchestrator to V4-Pro (Teleomorph)', () => {
    vi.stubEnv('DEEPSEEK_MODEL', '');
    expect(roleToModel('repl-with-reasoning')).toBe('deepseek-v4-pro');
    expect(roleToModel('germination')).toBe('deepseek-v4-pro');
    expect(roleToModel('orchestrator')).toBe('deepseek-v4-pro');
  });
});

describe('roleToModel — DEEPSEEK_MODEL env override', () => {
  it('returns env value for every role when set non-empty', () => {
    vi.stubEnv('DEEPSEEK_MODEL', 'ollama:llama3');
    for (const role of ROLES) {
      expect(roleToModel(role)).toBe('ollama:llama3');
    }
  });

  it('treats empty-string env as unset; falls back to ROLE_MAP', () => {
    vi.stubEnv('DEEPSEEK_MODEL', '');
    expect(roleToModel('subagent')).toBe('deepseek-v4-flash');
  });

  it('returns ROLE_MAP value when env undefined', () => {
    vi.unstubAllEnvs();
    // biome-ignore lint/performance/noDelete: must remove key from process.env, not just assign undefined (which sets the string "undefined")
    delete process.env.DEEPSEEK_MODEL;
    expect(roleToModel('orchestrator')).toBe('deepseek-v4-pro');
  });
});

describe('checkAndWarnEnvOverride', () => {
  it('emits no log + no stderr when env unset', () => {
    vi.unstubAllEnvs();
    // biome-ignore lint/performance/noDelete: must remove key from process.env, not just assign undefined (which sets the string "undefined")
    delete process.env.DEEPSEEK_MODEL;
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // biome-ignore lint/suspicious/noExplicitAny: test mock cast
    checkAndWarnEnvOverride(logger as any);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it('emits structured log + unmissable stderr when env set', () => {
    vi.stubEnv('DEEPSEEK_MODEL', 'override-model');
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // biome-ignore lint/suspicious/noExplicitAny: test mock cast
    checkAndWarnEnvOverride(logger as any);
    expect(logger.warn).toHaveBeenCalledWith({
      event: 'deepseek_model_override',
      model: 'override-model',
    });
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const stderrArg = stderrSpy.mock.calls[0]?.[0];
    expect(stderrArg).toContain('DEEPSEEK_MODEL env var is set');
    expect(stderrArg).toContain('override-model');
    expect(stderrArg).toContain('Bypassing Anamorph/Teleomorph');
    stderrSpy.mockRestore();
  });
});
