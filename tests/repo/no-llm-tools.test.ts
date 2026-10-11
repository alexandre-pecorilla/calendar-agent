import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The model has no tools (action plan §6.1): no file under src/ may declare
 * functions, tools or a tool choice in any spelling, and the only place that
 * talks to the model is src/llm/deepseek.ts (R4-6 widened the sweep).
 */
const files = (readdirSync('src', { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));

describe('LLM has no tools', () => {
  it('declares no tools or functions anywhere under src/', () => {
    for (const f of files) {
      const text = readFileSync(join('src', f), 'utf8');
      expect(text, `${f} declares tools`).not.toMatch(/\btools\s*[:=]|\bfunctions\s*[:=]|tool_choice|function_call|parallel_tool_calls|\[\s*['"](tools|functions|tool_choice)['"]\s*\]|['"](tools|functions|tool_choice)['"]\s*:/);
    }
  });
  it('only src/llm/deepseek.ts calls the model', () => {
    const callers = files.filter((f) => /chat\.completions\.create|new OpenAI\(|responses\.create|\.completions\b/.test(readFileSync(join('src', f), 'utf8')));
    expect(callers).toEqual(['llm/deepseek.ts']);
  });
});
