export * from './publisher-trust/contracts';

export {
  createLocalPluginPackagePublisherTrustRegistry,
  localPluginPackagePublisherKeyRevocationImpactDigest,
  normalizeLocalPluginPackagePublisherTrustDocument,
} from './publisher-trust/codec';

export { inspectLocalPluginPackagePublisherTrust } from './publisher-trust/lifecycle/inspection';
export {
  assertLocalPluginPackagePublisherKeyPublicationAllowed,
  publishLocalPluginPackagePublisherTrust,
} from './publisher-trust/lifecycle/publication';
export { retireLocalPluginPackagePublisherKey } from './publisher-trust/lifecycle/retirement';
export {
  confirmLocalPluginPackagePublisherKeyRevocation,
  proposeLocalPluginPackagePublisherKeyRevocation,
} from './publisher-trust/lifecycle/revocation';
