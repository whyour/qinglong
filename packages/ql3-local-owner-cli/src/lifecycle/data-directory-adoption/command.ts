import {
  LOCAL_DATA_DIRECTORY_ADOPTION_INSPECT_OPERATION,
  LOCAL_DATA_DIRECTORY_ADOPTION_STAGE_OPERATION,
  LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_OPERATION,
  LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION,
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
import {
  transformLocalDataDirectoryAdoption,
  verifyLocalDataDirectoryAdoptionTransformation,
  type LocalDataDirectoryTransformationResult,
} from './transformation/transformation';

export type LocalDataDirectoryAdoptionProductCommandResult =
  | LocalDataDirectoryAdoptionInspectResult
  | LocalDataDirectoryAdoptionMutationResult
  | LocalDataDirectoryTransformationResult;

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
  if (command.operation === LOCAL_DATA_DIRECTORY_ADOPTION_VERIFY_OPERATION) {
    return verifyLocalDataDirectoryAdoption(command);
  }
  if (command.operation === LOCAL_DATA_DIRECTORY_ADOPTION_TRANSFORM_OPERATION) {
    return transformLocalDataDirectoryAdoption(command);
  }
  return verifyLocalDataDirectoryAdoptionTransformation(command);
}
