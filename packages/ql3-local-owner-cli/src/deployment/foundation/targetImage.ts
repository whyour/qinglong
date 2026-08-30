import { LocalDeploymentConfigurationError } from './error';

const IMAGE_DIGEST_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}@sha256:[0-9a-f]{64}$/;
const LOCAL_IMAGE_REFERENCE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface LocalDeploymentTargetImage {
  readonly authority: 'registry-digest' | 'local-image-id';
  readonly reference: string;
  readonly imageId: string;
}

export function normalizeLocalDeploymentTargetImage(
  value: unknown,
  label = 'targetImage',
): Readonly<LocalDeploymentTargetImage> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new LocalDeploymentConfigurationError(`${label} must be an object`);
  }
  const image = value as Record<string, unknown>;
  const keys = Object.keys(image).sort();
  if (
    JSON.stringify(keys) !==
    JSON.stringify(['authority', 'imageId', 'reference'])
  ) {
    throw new LocalDeploymentConfigurationError(`${label} shape is invalid`);
  }
  if (
    (image.authority !== 'registry-digest' &&
      image.authority !== 'local-image-id') ||
    typeof image.reference !== 'string' ||
    (image.authority === 'registry-digest'
      ? !IMAGE_DIGEST_PATTERN.test(image.reference)
      : !LOCAL_IMAGE_REFERENCE_PATTERN.test(image.reference)) ||
    typeof image.imageId !== 'string' ||
    !IMAGE_ID_PATTERN.test(image.imageId)
  ) {
    throw new LocalDeploymentConfigurationError(
      `${label} identity is invalid`,
    );
  }
  return Object.freeze({
    authority: image.authority,
    reference: image.reference,
    imageId: image.imageId,
  });
}
