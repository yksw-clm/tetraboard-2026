import { getAnalysisLegalActions, type AnalysisPosition } from "./analysis";
import { encodeStateFeatures } from "./modelFeatureEncoding";
export {
  featureVersion,
  positionFeatureSize,
  historyFeatureSize,
  currentFeatureSize,
  maxHistoryEntries,
} from "./modelFeatureEncoding";
export type { SparseFeatures, ModelFeatures } from "./modelFeatureEncoding";

export function encodeModelFeatures(position: AnalysisPosition) {
  getAnalysisLegalActions(position);
  return encodeStateFeatures(position.state);
}
