import { setTimeout as sleep } from 'node:timers/promises';

import { GitHub } from '@actions/github/lib/utils';

import { ANNOTATION_LEVEL_FAILURE, ANNOTATION_LEVEL_NOTICE, ANNOTATION_LEVEL_WARNING, IAnnotation, ICheckResult } from './model';

export type Octokit = InstanceType<typeof GitHub>;

export interface ICheckTarget {
  owner: string;
  repo: string;
  headSha: string;
  runId: number;
  runUrl: string;
}

const MAX_ANNOTATIONS_PER_REQUEST = 50;
const MAX_LOG_LENGTH = 60000;
const UPDATE_RETRY_DELAYS_MS = [1000, 2000, 4000];

export class ChecksPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChecksPermissionError';
  }
}

const getErrorStatus = (error: unknown): number | undefined => {
  return typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : undefined;
};

export const buildCheckOutput = (result: ICheckResult): { title: string; summary: string; text: string } => {
  const countAnnotations = (level: string): number => result.annotations.filter((annotation: IAnnotation): boolean => annotation.annotation_level === level).length;
  const annotationCounts = [
    [countAnnotations(ANNOTATION_LEVEL_FAILURE), 'failure(s)'],
    [countAnnotations(ANNOTATION_LEVEL_WARNING), 'warning(s)'],
    [countAnnotations(ANNOTATION_LEVEL_NOTICE), 'notice(s)'],
  ].filter(([count]): boolean => Number(count) > 0).map(([count, label]): string => `${count} ${label}`);
  const outcome = result.isSuccess ? 'Passed' : `Failed${result.exitCode !== null ? ` (exit code ${result.exitCode})` : ''}`;
  const isLogTruncated = result.log.length > MAX_LOG_LENGTH;
  const logTail = isLogTruncated ? result.log.slice(-MAX_LOG_LENGTH) : result.log;
  return {
    title: `${outcome} in ${result.durationSeconds}s`,
    summary: annotationCounts.length > 0 ? annotationCounts.join(', ') : 'No annotations.',
    text: `${isLogTruncated ? 'Log (last part):' : 'Log:'}\n\n\`\`\`\n${logTail.trimEnd().replace(/```/g, '`\u200b``')}\n\`\`\``,
  };
};

export const createInProgressCheck = async (octokit: Octokit, target: ICheckTarget, checkName: string): Promise<number> => {
  try {
    const response = await octokit.rest.checks.create({
      owner: target.owner,
      repo: target.repo,
      name: checkName,
      head_sha: target.headSha,
      external_id: String(target.runId),
      details_url: target.runUrl,
      status: 'in_progress',
    });
    return response.data.id;
  } catch (error) {
    if (getErrorStatus(error) === 403) {
      throw new ChecksPermissionError(`The token can't create checks, give the job checks: write permission. Details: ${error}`);
    }
    throw error;
  }
};

const updateCheckWithRetries = async (octokit: Octokit, target: ICheckTarget, checkRunId: number, parameters: Record<string, unknown>, retryDelaysMs: number[]): Promise<void> => {
  try {
    await octokit.rest.checks.update({ owner: target.owner, repo: target.repo, check_run_id: checkRunId, ...parameters });
  } catch (error) {
    // NOTE(krishan711): GitHub can return 404 for a check run created moments earlier, so give it time to appear before giving up
    if (getErrorStatus(error) === 404 && retryDelaysMs.length > 0) {
      await sleep(retryDelaysMs[0]);
      await updateCheckWithRetries(octokit, target, checkRunId, parameters, retryDelaysMs.slice(1));
      return;
    }
    throw error;
  }
};

export const completeCheck = async (octokit: Octokit, target: ICheckTarget, checkRunId: number, result: ICheckResult): Promise<void> => {
  const output = buildCheckOutput(result);
  const annotationBatches: IAnnotation[][] = [];
  for (let index = 0; index < result.annotations.length; index += MAX_ANNOTATIONS_PER_REQUEST) {
    annotationBatches.push(result.annotations.slice(index, index + MAX_ANNOTATIONS_PER_REQUEST));
  }
  const [firstAnnotations = [], ...remainingAnnotationBatches] = annotationBatches;
  await updateCheckWithRetries(octokit, target, checkRunId, {
    status: 'completed',
    conclusion: result.isSuccess ? 'success' : 'failure',
    output: { ...output, annotations: firstAnnotations },
  }, UPDATE_RETRY_DELAYS_MS);
  // NOTE(krishan711): each update appends its annotations to the check, so batches go one after another
  await remainingAnnotationBatches.reduce(async (previousUpdate: Promise<void>, batchAnnotations: IAnnotation[]): Promise<void> => {
    await previousUpdate;
    await updateCheckWithRetries(octokit, target, checkRunId, { output: { ...output, annotations: batchAnnotations } }, UPDATE_RETRY_DELAYS_MS);
  }, Promise.resolve());
};
