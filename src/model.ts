export const SKIP_ENVIRONMENT_VARIABLE = 'CHECKS_ALREADY_PASSED';

export const ANNOTATION_LEVEL_NOTICE = 'notice';
export const ANNOTATION_LEVEL_WARNING = 'warning';
export const ANNOTATION_LEVEL_FAILURE = 'failure';

export type AnnotationLevel = typeof ANNOTATION_LEVEL_NOTICE | typeof ANNOTATION_LEVEL_WARNING | typeof ANNOTATION_LEVEL_FAILURE;

export interface IAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
  title?: string;
  message: string;
  annotation_level: AnnotationLevel;
}

export interface ICheckDefinition {
  name: string;
  command: string;
  checkName: string | null;
  annotationsFile: string | null;
  stdoutFile: string | null;
}

export interface ICheckResult {
  definition: ICheckDefinition;
  isSuccess: boolean;
  exitCode: number | null;
  durationSeconds: number;
  log: string;
  annotations: IAnnotation[];
}
