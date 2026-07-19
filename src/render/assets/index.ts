/** Authored-geometry loading: the public surface of `render/assets/`. */

export { AssetLibrary, type AssetLibraryOptions } from './assetLibrary.js';
export {
  AssetRegistry,
  sharedAssetRegistry,
  resetSharedAssetRegistry,
  type AssetRegistryOptions,
  type AssetRegistryStats,
  type LoadedModel,
  type ModelLoader,
} from './assetRegistry.js';
export {
  PART_ROLES,
  materialSlotForRole,
  roleForObjectName,
  type FixedPartRole,
  type PartRole,
} from './roles.js';
