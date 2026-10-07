import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

interface IDockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// NOTE(krishan711): stdoutPath sends stdout (and stderr too when combineOutput is set) straight to a file instead of keeping it in memory
const runDocker = async (args: string[], stdoutPath: string | null = null, combineOutput = false): Promise<IDockerResult> => {
  if (stdoutPath) {
    await mkdir(path.dirname(stdoutPath), { recursive: true });
  }
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const outputFile = stdoutPath ? createWriteStream(stdoutPath) : null;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer): void => {
    if (outputFile) {
      outputFile.write(chunk);
    } else {
      stdout += chunk.toString();
    }
  });
  child.stderr.on('data', (chunk: Buffer): void => {
    if (outputFile && combineOutput) {
      outputFile.write(chunk);
    } else {
      stderr += chunk.toString();
    }
  });
  const [exitCode] = await once(child, 'close') as [number | null];
  if (outputFile) {
    outputFile.end();
    await once(outputFile, 'finish');
  }
  return { exitCode: exitCode ?? 1, stdout, stderr };
};

const runDockerOrThrow = async (args: string[]): Promise<string> => {
  const result = await runDocker(args);
  if (result.exitCode !== 0) {
    throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
};

// NOTE(krishan711): pulls the image first when it isn't local, docker run would pull it anyway but inspect doesn't
export const getImageWorkingDirectory = async (image: string): Promise<string> => {
  const inspectArgs = ['image', 'inspect', '--format', '{{.Config.WorkingDir}}', image];
  const inspectResult = await runDocker(inspectArgs);
  if (inspectResult.exitCode === 0) {
    return inspectResult.stdout.trim() || '/';
  }
  await runDockerOrThrow(['pull', '--quiet', image]);
  return (await runDockerOrThrow(inspectArgs)) || '/';
};

export const startContainer = async (containerName: string, image: string, command: string): Promise<void> => {
  await runDockerOrThrow(['run', '--detach', '--name', containerName, image, 'sh', '-c', command]);
};

export const waitForContainer = async (containerName: string): Promise<number> => {
  return Number(await runDockerOrThrow(['wait', containerName]));
};

export const writeContainerLogs = async (containerName: string, filePath: string, stdoutOnly: boolean): Promise<void> => {
  await runDocker(['logs', containerName], filePath, !stdoutOnly);
};

export const copyFromContainer = async (containerName: string, containerPath: string, hostPath: string): Promise<void> => {
  await runDockerOrThrow(['cp', `${containerName}:${containerPath}`, hostPath]);
};

export const removeContainer = async (containerName: string): Promise<void> => {
  await runDocker(['rm', '--force', containerName]);
};
