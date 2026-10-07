import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { endGroup, getInput, getState, summary as jobSummary, info as logInfo, saveState, setFailed, setOutput, startGroup, warning } from '@actions/core';
import { getOctokit, context as githubContext } from '@actions/github';

import { parseCheckDefinitions } from './check-definitions';
import { copyFromContainer, getImageWorkingDirectory, removeContainer, startContainer, waitForContainer, writeContainerLogs } from './docker';
import { ChecksPermissionError, completeCheck, createInProgressCheck, ICheckTarget, Octokit } from './github-checks';
import { IAnnotation, ICheckDefinition, ICheckResult, SKIP_ENVIRONMENT_VARIABLE } from './model';

const CHECK_RUN_IDS_STATE = 'checkRunIds';
const CONTAINER_NAMES_STATE = 'containerNames';

const getErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const buildCheckTarget = (): ICheckTarget => {
  const { owner, repo } = githubContext.repo;
  return {
    owner,
    repo,
    // NOTE(krishan711): on pull requests github.sha is a merge commit the PR page doesn't show, so checks go on the PR's head commit
    headSha: githubContext.payload.pull_request?.head.sha ?? githubContext.sha,
    runId: githubContext.runId,
    runUrl: `${githubContext.serverUrl}/${owner}/${repo}/actions/runs/${githubContext.runId}`,
  };
};

const readAnnotations = async (containerName: string, definition: ICheckDefinition, workingDirectory: string, pathPrefix: string, tempDirectory: string): Promise<IAnnotation[]> => {
  if (!definition.annotationsFile) {
    return [];
  }
  const annotationsPath = path.join(tempDirectory, `${containerName}-annotations.json`);
  try {
    await copyFromContainer(containerName, path.posix.resolve(workingDirectory, definition.annotationsFile), annotationsPath);
    const annotations = JSON.parse(await fs.readFile(annotationsPath, 'utf8')) as IAnnotation[];
    return annotations.map((annotation: IAnnotation): IAnnotation => ({ ...annotation, path: path.join(pathPrefix, annotation.path) }));
  } catch (error) {
    warning(`${definition.name}: could not read ${definition.annotationsFile}: ${getErrorMessage(error)}`);
    return [];
  }
};

const runCheck = async (containerName: string, definition: ICheckDefinition, image: string, workingDirectory: string, pathPrefix: string, tempDirectory: string): Promise<ICheckResult> => {
  const logPath = path.join(tempDirectory, `${containerName}.log`);
  const startTime = Date.now();
  let exitCode: number | null = null;
  let annotations: IAnnotation[] = [];
  let errorMessage = '';
  try {
    await startContainer(containerName, image, definition.command);
    exitCode = await waitForContainer(containerName);
    await writeContainerLogs(containerName, logPath, false);
    if (definition.stdoutFile) {
      await writeContainerLogs(containerName, path.resolve(definition.stdoutFile), true);
    }
    annotations = await readAnnotations(containerName, definition, workingDirectory, pathPrefix, tempDirectory);
  } catch (error) {
    errorMessage = getErrorMessage(error);
  } finally {
    await removeContainer(containerName);
  }
  const log = await fs.readFile(logPath, 'utf8').catch((): string => '');
  return {
    definition,
    isSuccess: exitCode === 0 && !errorMessage,
    exitCode,
    durationSeconds: Math.round((Date.now() - startTime) / 1000),
    log: errorMessage ? `${log}\n${errorMessage}` : log,
    annotations,
  };
};

const createChecks = async (octokit: Octokit, target: ICheckTarget, definitions: ICheckDefinition[]): Promise<Map<string, number>> => {
  const checkRunIds = new Map<string, number>();
  let canCreateChecks = true;
  await definitions.reduce(async (previousCreate: Promise<void>, definition: ICheckDefinition): Promise<void> => {
    await previousCreate;
    if (!definition.checkName || !canCreateChecks) {
      return;
    }
    try {
      checkRunIds.set(definition.name, await createInProgressCheck(octokit, target, definition.checkName));
      // NOTE(krishan711): saved after every creation so the post step can cancel the created checks even if a later creation fails
      saveState(CHECK_RUN_IDS_STATE, JSON.stringify([...checkRunIds.values()]));
    } catch (error) {
      if (!(error instanceof ChecksPermissionError)) {
        throw error;
      }
      // NOTE(krishan711): pull requests from forks only get a read-only token, the checks still run but can't be reported separately
      canCreateChecks = false;
      warning(`Running the checks without reporting them as separate checks: ${error.message}`, { title: 'Checks not reported' });
    }
  }, Promise.resolve());
  return checkRunIds;
};

const writeJobSummary = async (results: ICheckResult[]): Promise<void> => {
  await jobSummary.addTable([
    [{ data: 'Check', header: true }, { data: 'Result', header: true }, { data: 'Duration', header: true }],
    ...results.map((result: ICheckResult): string[] => [result.definition.checkName ?? result.definition.name, result.isSuccess ? 'Passed' : 'Failed', `${result.durationSeconds}s`]),
  ]).write();
};

const runChecks = async (): Promise<void> => {
  if (process.env[SKIP_ENVIRONMENT_VARIABLE] === 'true') {
    logInfo(`Skipping: ${SKIP_ENVIRONMENT_VARIABLE} is set, these checks already passed on an earlier run`);
    return;
  }
  const image = getInput('image', { required: true });
  const definitions = parseCheckDefinitions(getInput('checks', { required: true }));
  const pathPrefix = getInput('annotations-path-prefix', { required: false });
  const octokit = getOctokit(getInput('github-token', { required: true }));
  const target = buildCheckTarget();
  const workingDirectory = await getImageWorkingDirectory(image);
  const tempDirectory = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'docker-checks-'));
  const checkRunIds = await createChecks(octokit, target, definitions);
  const containerNames = definitions.map((definition: ICheckDefinition): string => `${definition.name.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${randomUUID().slice(0, 8)}`);
  saveState(CONTAINER_NAMES_STATE, JSON.stringify(containerNames));
  logInfo(`Running ${definitions.length} checks in ${image}: ${definitions.map((definition: ICheckDefinition): string => definition.name).join(', ')}`);
  const results = await Promise.all(definitions.map(async (definition: ICheckDefinition, index: number): Promise<ICheckResult> => {
    const result = await runCheck(containerNames[index], definition, image, workingDirectory, pathPrefix, tempDirectory);
    logInfo(`${result.isSuccess ? 'Passed' : 'Failed'}: ${definition.name} in ${result.durationSeconds}s`);
    const checkRunId = checkRunIds.get(definition.name);
    if (checkRunId) {
      await completeCheck(octokit, target, checkRunId, result).catch((error: unknown): void => warning(`${definition.name}: could not report the check: ${getErrorMessage(error)}`));
    }
    return result;
  }));
  results.forEach((result: ICheckResult): void => {
    startGroup(`${result.isSuccess ? 'Passed' : 'Failed'}: ${result.definition.name} (${result.durationSeconds}s)`);
    logInfo(result.log);
    endGroup();
  });
  await writeJobSummary(results);
  const failedNames = results.filter((result: ICheckResult): boolean => !result.isSuccess).map((result: ICheckResult): string => result.definition.name);
  setOutput('failed-checks', failedNames.join(','));
  if (failedNames.length > 0) {
    setFailed(`${failedNames.length} check(s) failed: ${failedNames.join(', ')}`);
  }
};

// NOTE(krishan711): runs after the job even when cancelled or timed out, cleaning up checks and their containers
const cancelUnfinishedChecks = async (): Promise<void> => {
  const containerNames = JSON.parse(getState(CONTAINER_NAMES_STATE) || '[]') as string[];
  await Promise.all(containerNames.map((containerName: string): Promise<void> => removeContainer(containerName)));
  const checkRunIds = JSON.parse(getState(CHECK_RUN_IDS_STATE) || '[]') as number[];
  if (checkRunIds.length === 0) {
    return;
  }
  const octokit = getOctokit(getInput('github-token', { required: true }));
  const target = buildCheckTarget();
  await Promise.all(checkRunIds.map(async (checkRunId: number): Promise<void> => {
    const checkRun = await octokit.rest.checks.get({ owner: target.owner, repo: target.repo, check_run_id: checkRunId });
    if (checkRun.data.status !== 'completed') {
      await octokit.rest.checks.update({ owner: target.owner, repo: target.repo, check_run_id: checkRunId, status: 'completed', conclusion: 'cancelled' });
    }
  }));
};

const run = async (): Promise<void> => {
  const isPost = getState('isPost') === 'true';
  saveState('isPost', 'true');
  try {
    await (isPost ? cancelUnfinishedChecks() : runChecks());
  } catch (error) {
    if (isPost) {
      warning(`Could not clean up unfinished checks or containers: ${getErrorMessage(error)}`);
    } else {
      setFailed(getErrorMessage(error));
    }
  }
};

run();
