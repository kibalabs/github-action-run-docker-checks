import { parse as parseYaml } from 'yaml';

import { ICheckDefinition } from './model';

const KNOWN_FIELDS = ['name', 'command', 'check-name', 'annotations-file', 'stdout-file'];

const readOptionalString = (entry: Record<string, unknown>, field: string, checkLabel: string): string | null => {
  const value = entry[field];
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${checkLabel}: ${field} must be a non-empty string`);
  }
  return value.trim();
};

export const parseCheckDefinitions = (checksInput: string): ICheckDefinition[] => {
  const parsed = parseYaml(checksInput) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('checks must be a YAML list with at least one check');
  }
  const definitions = parsed.map((entry: unknown, index: number): ICheckDefinition => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`check ${index + 1}: must be a mapping with a name and a command`);
    }
    const record = entry as Record<string, unknown>;
    const name = readOptionalString(record, 'name', `check ${index + 1}`);
    if (!name) {
      throw new Error(`check ${index + 1}: name is required`);
    }
    const unknownFields = Object.keys(record).filter((field: string): boolean => !KNOWN_FIELDS.includes(field));
    if (unknownFields.length > 0) {
      throw new Error(`${name}: unknown field(s) ${unknownFields.join(', ')}, expected ${KNOWN_FIELDS.join(', ')}`);
    }
    const command = readOptionalString(record, 'command', name);
    if (!command) {
      throw new Error(`${name}: command is required`);
    }
    const checkName = readOptionalString(record, 'check-name', name);
    const annotationsFile = readOptionalString(record, 'annotations-file', name);
    if (annotationsFile && !checkName) {
      throw new Error(`${name}: annotations-file needs a check-name to attach the annotations to`);
    }
    return { name, command, checkName, annotationsFile, stdoutFile: readOptionalString(record, 'stdout-file', name) };
  });
  const duplicateNames = definitions.map((definition: ICheckDefinition): string => definition.name).filter((name: string, index: number, names: string[]): boolean => names.indexOf(name) !== index);
  if (duplicateNames.length > 0) {
    throw new Error(`check names must be unique, repeated: ${[...new Set(duplicateNames)].join(', ')}`);
  }
  return definitions;
};
