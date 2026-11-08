/**
 * Auto-generated from docs/seed_data_sources.sql
 * Do not edit manually - run "npm run generate:types" to regenerate
 */

import type { ConnectorProtocol } from "swatchwatch-shared";

export type SupportedConnectorSource =
  | "AlchemyLacquersShopify"
  | "BarryMShopify"
  | "BeesKneesLacquerShopify"
  | "BeyondPolishShopify"
  | "ChinaGlazeShopify"
  | "CirqueColorsShopify"
  | "ClionadhShopify"
  | "CndShopify"
  | "ColorClubShopify"
  | "CosIng"
  | "CoteShopify"
  | "CrackedPolishShopify"
  | "CupcakePolishShopify"
  | "DamNailPolishShopify"
  | "DeborahLippmannShopify"
  | "DrunkFairyPolishShopify"
  | "EmilyDeMollyShopify"
  | "GS1Lookup"
  | "GardenPathLacquersShopify"
  | "GreatLakesLacquerShopify"
  | "HarlowAndCoShopify"
  | "HoloTacoShopify"
  | "HypnoticPolishShopify"
  | "ImpactAffiliateNetwork"
  | "KathleenAndCoShopify"
  | "LeMiniMacaronShopify"
  | "LemmingLacquerShopify"
  | "LightsLacquerShopify"
  | "LondontownShopify"
  | "LoudBabbsShopify"
  | "MakeupAPI"
  | "ManucuristShopify"
  | "MavalaShopify"
  | "MooncatShopify"
  | "NightOwlLacquerShopify"
  | "NoodlesNailPolishShopify"
  | "OliveAndJuneShopify"
  | "OliveAvePolishShopify"
  | "OpenBeautyFacts"
  | "OrlyShopify"
  | "PahlishShopify"
  | "PaintItPrettyPolishShopify"
  | "PenelopeLuzShopify"
  | "PiggyPaintShopify"
  | "PolishPickupShopify"
  | "PotionPolishShopify"
  | "PrismParadeShopify"
  | "RakutenAdvertising"
  | "RedEyedLacquerShopify"
  | "RogueLacquerShopify"
  | "RoylaleeShopify"
  | "SassysaucePolishShopify"
  | "StarrilyShopify"
  | "StellaChromaShopify"
  | "SweetAndSourLacquerShopify"
  | "TylerStrinketsShopify"
  | "UserCapture"
  | "WetNWildShopify"
  | "ZombieClawPolishShopify"
  | "openFDA_CosmeticEvents";

/** Maps each connector source to its protocol group for UI grouping and bulk selection. */
export const SOURCE_PROTOCOL_MAP: Record<SupportedConnectorSource, ConnectorProtocol> = {
  AlchemyLacquersShopify: "Shopify",
  BarryMShopify: "Shopify",
  BeesKneesLacquerShopify: "Shopify",
  BeyondPolishShopify: "Shopify",
  ChinaGlazeShopify: "Shopify",
  CirqueColorsShopify: "Shopify",
  ClionadhShopify: "Shopify",
  CndShopify: "Shopify",
  ColorClubShopify: "Shopify",
  CosIng: "GS1",
  CoteShopify: "Shopify",
  CrackedPolishShopify: "Shopify",
  CupcakePolishShopify: "Shopify",
  DamNailPolishShopify: "Shopify",
  DeborahLippmannShopify: "Shopify",
  DrunkFairyPolishShopify: "Shopify",
  EmilyDeMollyShopify: "Shopify",
  GS1Lookup: "GS1",
  GardenPathLacquersShopify: "Shopify",
  GreatLakesLacquerShopify: "Shopify",
  HarlowAndCoShopify: "Shopify",
  HoloTacoShopify: "HoloTaco",
  HypnoticPolishShopify: "Shopify",
  ImpactAffiliateNetwork: "Custom",
  KathleenAndCoShopify: "Shopify",
  LeMiniMacaronShopify: "Shopify",
  LemmingLacquerShopify: "Shopify",
  LightsLacquerShopify: "Shopify",
  LondontownShopify: "Shopify",
  LoudBabbsShopify: "Shopify",
  MakeupAPI: "MakeupAPI",
  ManucuristShopify: "Shopify",
  MavalaShopify: "Shopify",
  MooncatShopify: "Shopify",
  NightOwlLacquerShopify: "Shopify",
  NoodlesNailPolishShopify: "Shopify",
  OliveAndJuneShopify: "Shopify",
  OliveAvePolishShopify: "Shopify",
  OpenBeautyFacts: "OpenBeautyFacts",
  OrlyShopify: "Shopify",
  PahlishShopify: "Shopify",
  PaintItPrettyPolishShopify: "Shopify",
  PenelopeLuzShopify: "Shopify",
  PiggyPaintShopify: "Shopify",
  PolishPickupShopify: "Shopify",
  PotionPolishShopify: "Shopify",
  PrismParadeShopify: "Shopify",
  RakutenAdvertising: "Custom",
  RedEyedLacquerShopify: "Shopify",
  RogueLacquerShopify: "Shopify",
  RoylaleeShopify: "Shopify",
  SassysaucePolishShopify: "Shopify",
  StarrilyShopify: "Shopify",
  StellaChromaShopify: "Shopify",
  SweetAndSourLacquerShopify: "Shopify",
  TylerStrinketsShopify: "Shopify",
  UserCapture: "Custom",
  WetNWildShopify: "Shopify",
  ZombieClawPolishShopify: "Shopify",
  openFDA_CosmeticEvents: "Custom",
};

// Runtime array for validation - same values as the type above
export const SUPPORTED_SOURCES: SupportedConnectorSource[] = [
  "AlchemyLacquersShopify",
  "BarryMShopify",
  "BeesKneesLacquerShopify",
  "BeyondPolishShopify",
  "ChinaGlazeShopify",
  "CirqueColorsShopify",
  "ClionadhShopify",
  "CndShopify",
  "ColorClubShopify",
  "CosIng",
  "CoteShopify",
  "CrackedPolishShopify",
  "CupcakePolishShopify",
  "DamNailPolishShopify",
  "DeborahLippmannShopify",
  "DrunkFairyPolishShopify",
  "EmilyDeMollyShopify",
  "GS1Lookup",
  "GardenPathLacquersShopify",
  "GreatLakesLacquerShopify",
  "HarlowAndCoShopify",
  "HoloTacoShopify",
  "HypnoticPolishShopify",
  "ImpactAffiliateNetwork",
  "KathleenAndCoShopify",
  "LeMiniMacaronShopify",
  "LemmingLacquerShopify",
  "LightsLacquerShopify",
  "LondontownShopify",
  "LoudBabbsShopify",
  "MakeupAPI",
  "ManucuristShopify",
  "MavalaShopify",
  "MooncatShopify",
  "NightOwlLacquerShopify",
  "NoodlesNailPolishShopify",
  "OliveAndJuneShopify",
  "OliveAvePolishShopify",
  "OpenBeautyFacts",
  "OrlyShopify",
  "PahlishShopify",
  "PaintItPrettyPolishShopify",
  "PenelopeLuzShopify",
  "PiggyPaintShopify",
  "PolishPickupShopify",
  "PotionPolishShopify",
  "PrismParadeShopify",
  "RakutenAdvertising",
  "RedEyedLacquerShopify",
  "RogueLacquerShopify",
  "RoylaleeShopify",
  "SassysaucePolishShopify",
  "StarrilyShopify",
  "StellaChromaShopify",
  "SweetAndSourLacquerShopify",
  "TylerStrinketsShopify",
  "UserCapture",
  "WetNWildShopify",
  "ZombieClawPolishShopify",
  "openFDA_CosmeticEvents",
];
