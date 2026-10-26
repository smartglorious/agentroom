import type { Provider } from "../core/types";

export type Modality = "text" | "image" | "audio";
export type DataSensitivity = "public" | "internal" | "restricted";

export interface ModelCapabilityProfile {
  id: string;
  provider: Provider;
  model?: string;
  modalities: Modality[];
  contextWindow: number;
  structuredOutput: boolean;
  toolCalling: boolean;
  codingTier: number;
  reasoningTier: number;
  local: boolean;
  regions: string[];
  sensitivity: DataSensitivity[];
  quality: number;
  reliability: number;
  latencyP95Ms: number;
  /** Undefined means the route may be selected, but any hard monetary cap must fail closed before dispatch. */
  estimatedCostMicros?: number;
  available: boolean;
  schemaFamily: string;
  catalogVersion: string;
}

export interface RoutingRequirements {
  modalities: Modality[];
  contextTokens: number;
  structuredOutput?: boolean;
  toolCalling?: boolean;
  minimumCodingTier?: number;
  minimumReasoningTier?: number;
  minimumQuality: number;
  sensitivity: DataSensitivity;
  allowedProviders?: Provider[];
  allowedRegions?: string[];
  localOnly?: boolean;
}

export interface RoutingWeights { quality: number; cost: number; latency: number; reliability: number }

export interface RouteDecision {
  primary: ModelCapabilityProfile;
  fallback?: ModelCapabilityProfile;
  candidates: { id: string; score: number }[];
  routeReason: string[];
  catalogVersion: string;
}

const supports = (profile: ModelCapabilityProfile, required: RoutingRequirements) =>
  profile.available
  && required.modalities.every((item) => profile.modalities.includes(item))
  && profile.contextWindow >= required.contextTokens
  && (!required.structuredOutput || profile.structuredOutput)
  && (!required.toolCalling || profile.toolCalling)
  && profile.codingTier >= (required.minimumCodingTier ?? 0)
  && profile.reasoningTier >= (required.minimumReasoningTier ?? 0)
  && profile.quality >= required.minimumQuality
  && profile.sensitivity.includes(required.sensitivity)
  && (!required.allowedProviders?.length || required.allowedProviders.includes(profile.provider))
  && (!required.allowedRegions?.length || profile.regions.some((region) => required.allowedRegions!.includes(region)))
  && (!required.localOnly || profile.local);

export function selectModelRoute(
  profiles: ModelCapabilityProfile[],
  required: RoutingRequirements,
  weights: RoutingWeights = { quality: 1, cost: 1, latency: 1, reliability: 1 },
): RouteDecision {
  if (!Number.isFinite(required.contextTokens) || required.contextTokens < 0) throw new Error("contextTokens must be non-negative");
  const eligible = profiles.filter((profile) => supports(profile, required));
  if (!eligible.length) throw new Error("No model satisfies the routing hard filters and quality floor");
  const knownCosts = eligible.flatMap((profile) => profile.estimatedCostMicros === undefined ? [] : [profile.estimatedCostMicros]);
  const maxCost = Math.max(1, ...knownCosts);
  const maxLatency = Math.max(1, ...eligible.map((profile) => profile.latencyP95Ms));
  const scored = eligible.map((profile) => ({ profile, score:
    weights.quality * profile.quality
    - weights.cost * (profile.estimatedCostMicros === undefined ? 1 : profile.estimatedCostMicros / maxCost)
    - weights.latency * (profile.latencyP95Ms / maxLatency)
    + weights.reliability * profile.reliability,
  })).sort((a, b) => b.score - a.score || a.profile.id.localeCompare(b.profile.id));
  const primary = scored[0].profile;
  const fallback = scored.slice(1).find(({ profile }) => profile.schemaFamily === primary.schemaFamily)?.profile;
  return {
    primary,
    fallback,
    candidates: scored.map(({ profile, score }) => ({ id: profile.id, score })),
    routeReason: [
      `${eligible.length}/${profiles.length} profiles passed hard filters`,
      `quality floor ${required.minimumQuality} satisfied`,
      `selected ${primary.id} by weighted quality/cost/latency/reliability score`,
      fallback ? `fallback ${fallback.id} shares schema family ${primary.schemaFamily}` : "no schema-compatible fallback",
    ],
    catalogVersion: primary.catalogVersion,
  };
}
