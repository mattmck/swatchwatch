/**
 * Auto-generated from docs/seed_data_sources.sql
 * Do not edit manually - run "npm run generate:types" to regenerate
 */

import type { ConnectorProtocol } from "swatchwatch-shared";

export type SupportedConnectorSource =
  | "BeesKneesLacquerShopify"
  | "ChinaGlazeShopify"
  | "ClionadhShopify"
  | "ColorClubShopify"
  | "CosIng"
  | "CrackedPolishShopify"
  | "CupcakePolishShopify"
  | "DrunkFairyPolishShopify"
  | "GS1Lookup"
  | "GardenPathLacquersShopify"
  | "GreatLakesLacquerShopify"
  | "HoloTacoShopify"
  | "ImpactAffiliateNetwork"
  | "KathleenAndCoShopify"
  | "LeMiniMacaronShopify"
  | "LightsLacquerShopify"
  | "LoudBabbsShopify"
  | "MakeupAPI"
  | "MooncatShopify"
  | "OliveAvePolishShopify"
  | "OpenBeautyFacts"
  | "OrlyShopify"
  | "PaintItPrettyPolishShopify"
  | "PotionPolishShopify"
  | "PrismParadeShopify"
  | "RakutenAdvertising"
  | "RedEyedLacquerShopify"
  | "RogueLacquerShopify"
  | "RoylaleeShopify"
  | "SassysaucePolishShopify"
  | "StarrilyShopify"
  | "TylerStrinketsShopify"
  | "UserCapture"
  | "ZombieClawPolishShopify"
  | "openFDA_CosmeticEvents";

/** Maps each connector source to its protocol group for UI grouping and bulk selection. */
export const SOURCE_PROTOCOL_MAP: Record<SupportedConnectorSource, ConnectorProtocol> = {
  BeesKneesLacquerShopify: "Shopify",
  ChinaGlazeShopify: "Shopify",
  ClionadhShopify: "Shopify",
  ColorClubShopify: "Shopify",
  CosIng: "GS1",
  CrackedPolishShopify: "Shopify",
  CupcakePolishShopify: "Shopify",
  DrunkFairyPolishShopify: "Shopify",
  GS1Lookup: "GS1",
  GardenPathLacquersShopify: "Shopify",
  GreatLakesLacquerShopify: "Shopify",
  HoloTacoShopify: "HoloTaco",
  ImpactAffiliateNetwork: "Custom",
  KathleenAndCoShopify: "Shopify",
  LeMiniMacaronShopify: "Shopify",
  LightsLacquerShopify: "Shopify",
  LoudBabbsShopify: "Shopify",
  MakeupAPI: "MakeupAPI",
  MooncatShopify: "Shopify",
  OliveAvePolishShopify: "Shopify",
  OpenBeautyFacts: "OpenBeautyFacts",
  OrlyShopify: "Shopify",
  PaintItPrettyPolishShopify: "Shopify",
  PotionPolishShopify: "Shopify",
  PrismParadeShopify: "Shopify",
  RakutenAdvertising: "Custom",
  RedEyedLacquerShopify: "Shopify",
  RogueLacquerShopify: "Shopify",
  RoylaleeShopify: "Shopify",
  SassysaucePolishShopify: "Shopify",
  StarrilyShopify: "Shopify",
  TylerStrinketsShopify: "Shopify",
  UserCapture: "Custom",
  ZombieClawPolishShopify: "Shopify",
  openFDA_CosmeticEvents: "Custom",
};

// Runtime array for validation - same values as the type above
export const SUPPORTED_SOURCES: SupportedConnectorSource[] = [
  "BeesKneesLacquerShopify",
  "ChinaGlazeShopify",
  "ClionadhShopify",
  "ColorClubShopify",
  "CosIng",
  "CrackedPolishShopify",
  "CupcakePolishShopify",
  "DrunkFairyPolishShopify",
  "GS1Lookup",
  "GardenPathLacquersShopify",
  "GreatLakesLacquerShopify",
  "HoloTacoShopify",
  "ImpactAffiliateNetwork",
  "KathleenAndCoShopify",
  "LeMiniMacaronShopify",
  "LightsLacquerShopify",
  "LoudBabbsShopify",
  "MakeupAPI",
  "MooncatShopify",
  "OliveAvePolishShopify",
  "OpenBeautyFacts",
  "OrlyShopify",
  "PaintItPrettyPolishShopify",
  "PotionPolishShopify",
  "PrismParadeShopify",
  "RakutenAdvertising",
  "RedEyedLacquerShopify",
  "RogueLacquerShopify",
  "RoylaleeShopify",
  "SassysaucePolishShopify",
  "StarrilyShopify",
  "TylerStrinketsShopify",
  "UserCapture",
  "ZombieClawPolishShopify",
  "openFDA_CosmeticEvents",
];
