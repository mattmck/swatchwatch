/**
 * Auto-generated from docs/seed_data_sources.sql
 * Do not edit manually - run "npm run generate:types" to regenerate
 */

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

import { ConnectorProtocol } from "swatchwatch-shared";

/** Maps each connector source to its protocol group for UI grouping and bulk selection. */
export const SOURCE_PROTOCOL_MAP: Record<SupportedConnectorSource, ConnectorProtocol> = {
  BeesKneesLacquerShopify: "Shopify",
  ChinaGlazeShopify: "Shopify",
  ClionadhShopify: "Shopify",
  ColorClubShopify: "Shopify",
  CrackedPolishShopify: "Shopify",
  CupcakePolishShopify: "Shopify",
  DrunkFairyPolishShopify: "Shopify",
  GardenPathLacquersShopify: "Shopify",
  GreatLakesLacquerShopify: "Shopify",
  HoloTacoShopify: "Shopify",
  KathleenAndCoShopify: "Shopify",
  LeMiniMacaronShopify: "Shopify",
  LightsLacquerShopify: "Shopify",
  LoudBabbsShopify: "Shopify",
  MooncatShopify: "Shopify",
  OliveAvePolishShopify: "Shopify",
  OrlyShopify: "Shopify",
  PaintItPrettyPolishShopify: "Shopify",
  PotionPolishShopify: "Shopify",
  PrismParadeShopify: "Shopify",
  RedEyedLacquerShopify: "Shopify",
  RogueLacquerShopify: "Shopify",
  RoylaleeShopify: "Shopify",
  SassysaucePolishShopify: "Shopify",
  StarrilyShopify: "Shopify",
  TylerStrinketsShopify: "Shopify",
  ZombieClawPolishShopify: "Shopify",
  OpenBeautyFacts: "OpenBeautyFacts",
  MakeupAPI: "MakeupAPI",
  CosIng: "GS1",
  GS1Lookup: "GS1",
  ImpactAffiliateNetwork: "Custom",
  RakutenAdvertising: "Custom",
  UserCapture: "Custom",
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
  "openFDA_CosmeticEvents",];
