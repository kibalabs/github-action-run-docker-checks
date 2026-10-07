import { describe, expect, it } from 'vitest';

import { parseCheckDefinitions } from '../src/check-definitions';

describe('parseCheckDefinitions', () => {
  it('reads every field', () => {
    const checks = '- name: lint\n  command: make lint-check-ci\n  check-name: api-lint\n  annotations-file: lint-results.json\n- name: openapi\n  command: make generate-openapi\n  stdout-file: docs/openapi.json\n';
    expect(parseCheckDefinitions(checks)).toEqual([
      { name: 'lint', command: 'make lint-check-ci', checkName: 'api-lint', annotationsFile: 'lint-results.json', stdoutFile: null },
      { name: 'openapi', command: 'make generate-openapi', checkName: null, annotationsFile: null, stdoutFile: 'docs/openapi.json' },
    ]);
  });

  it.each([
    ['', 'checks must be a YAML list with at least one check'],
    ['name: lint\ncommand: make lint\n', 'checks must be a YAML list with at least one check'],
    ['- make lint\n', 'check 1: must be a mapping with a name and a command'],
    ['- command: make lint\n', 'check 1: name is required'],
    ['- name: lint\n', 'lint: command is required'],
    ['- name: lint\n  command: ""\n', 'lint: command must be a non-empty string'],
    ['- name: lint\n  command: make lint\n  annotations-file: lint.json\n', 'lint: annotations-file needs a check-name to attach the annotations to'],
    ['- name: lint\n  command: make lint\n  check_name: api-lint\n', 'lint: unknown field(s) check_name, expected name, command, check-name, annotations-file, stdout-file'],
    ['- name: lint\n  command: make a\n- name: lint\n  command: make b\n', 'check names must be unique, repeated: lint'],
  ])('rejects %j', (checks: string, message: string) => {
    expect(() => parseCheckDefinitions(checks)).toThrow(message);
  });
});
