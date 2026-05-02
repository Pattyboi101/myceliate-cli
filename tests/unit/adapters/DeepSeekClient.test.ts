import { describe, expectTypeOf, it } from 'vitest';
import type { ChatRequest, DeepSeekClient } from '../../../src/adapters/DeepSeekClient.js';
import type { StreamEvent } from '../../../src/adapters/streamEvent.js';

describe('DeepSeekClient interface', () => {
  it('mandates a streaming entry point that yields canonical StreamEvents', () => {
    type StreamFn = DeepSeekClient['stream'];
    expectTypeOf<StreamFn>().toBeFunction();
    expectTypeOf<ReturnType<StreamFn>>().toEqualTypeOf<AsyncIterable<StreamEvent>>();
  });

  it('mandates ChatRequest carries thinking flag and strict-mode tool defs', () => {
    expectTypeOf<ChatRequest['thinking']>().toEqualTypeOf<boolean>();
    expectTypeOf<ChatRequest['tools']>().toMatchTypeOf<
      readonly { name: string; description: string; parameters: object }[] | undefined
    >();
  });
});
