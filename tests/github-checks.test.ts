import { describe, expect, it } from 'vitest';

import { buildCheckOutput } from '../src/github-checks';
import { IAnnotation, ICheckResult } from '../src/model';

const buildResult = (overrides: Partial<ICheckResult> = {}): ICheckResult => ({
  definition: { name: 'lint', command: 'make lint', checkName: 'api-lint', annotationsFile: null, stdoutFile: null },
  isSuccess: true,
  exitCode: 0,
  durationSeconds: 12,
  log: 'all good',
  annotations: [],
  ...overrides,
});

const buildAnnotation = (level: IAnnotation['annotation_level']): IAnnotation => ({ path: 'a.py', start_line: 1, end_line: 1, message: 'm', annotation_level: level });

describe('buildCheckOutput', () => {
  it('describes a passing check', () => {
    expect(buildCheckOutput(buildResult())).toEqual({ title: 'Passed in 12s', summary: 'No annotations.', text: 'Log:\n\n```\nall good\n```' });
  });

  it('describes a failing check with its exit code and annotation counts', () => {
    const output = buildCheckOutput(buildResult({ isSuccess: false, exitCode: 2, annotations: [buildAnnotation('failure'), buildAnnotation('failure'), buildAnnotation('notice')] }));
    expect(output.title).toBe('Failed (exit code 2) in 12s');
    expect(output.summary).toBe('2 failure(s), 1 notice(s)');
  });

  it('describes a check that could not start', () => {
    expect(buildCheckOutput(buildResult({ isSuccess: false, exitCode: null })).title).toBe('Failed in 12s');
  });

  it('keeps the end of a long log', () => {
    const output = buildCheckOutput(buildResult({ log: `${'x'.repeat(70000)}the end` }));
    expect(output.text.startsWith('Log (last part):')).toBe(true);
    expect(output.text.endsWith('the end\n```')).toBe(true);
    expect(output.text.length).toBeLessThan(65535);
  });

  it('cannot be broken out of its code block by the log', () => {
    expect(buildCheckOutput(buildResult({ log: 'a ``` b' })).text).not.toContain('a ``` b');
  });
});
