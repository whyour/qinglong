import {
  LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION,
  LOCAL_DATA_DIRECTORY_ADOPTION_STAGE_OPERATION,
  normalizeLocalDataDirectoryAdoptionCommand,
} from './contract';
import {
  inspectLocalDataDirectoryAdoption,
  type LocalDataDirectoryAdoptionInspectResult,
} from './inventory';
import {
  stageLocalDataDirectoryAdoption,
  verifyLocalDataDirectoryAdoption,
  type LocalDataDirectoryAdoptionMutationResult,
} from './staging';

export type LocalDataDirectoryAdoptionProductCommandResult =
  | LocalDataDirectoryAdoptionInspectResult
  | LocalDataDirectoryAdoptionMutationResult;

export async function runLocalDataDirectoryAdoptionProductCommand(
  value: unknown,
): Promise<Readonly<LocalDataDirectoryAdoptionProductCommandResult>> {
  const command = normalizeLocalDataDirectoryAdoptionCommand(value);
  if (command.operation === LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION) {
    return inspectLocalDataDirectoryAdoption(command);
  }
  if (command.operation === LOCAL_DATA_DIRECTORY_ADOPTION_STAGE_OPERATION) {
    return stageLocalDataDirectoryAdoption(command);
  }
  return verifyLocalDataDirectoryAdoption(command);
}
