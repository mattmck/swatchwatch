/**
 * Auto-generated from docs/seed_data_sources.sql
 * Do not edit manually - run "npm run generate:types" to regenerate
 */

import type { ConnectorProtocol } from "swatchwatch-shared";

export type SupportedConnectorSource =
  | "AlchemyLacquersShopify"
  | "AnchorAndHeartShopify"
  | "BarryMShopify"
  | "BeesKneesLacquerShopify"
  | "BeyondPolishShopify"
  | "ButterLondonShopify"
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
  | "DazzleDryShopify"
  | "DeborahLippmannShopify"
  | "DndShopify"
  | "DreamlandLacquerShopify"
  | "DrunkFairyPolishShopify"
  | "EllaMilaShopify"
  | "EmilyDeMollyShopify"
  | "EtherealLacquerShopify"
  | "FunLacquerShopify"
  | "GS1Lookup"
  | "GardenPathLacquersShopify"
  | "GlamPolishShopify"
  | "GreatLakesLacquerShopify"
  | "HarlowAndCoShopify"
  | "HoloTacoShopify"
  | "HypnoticPolishShopify"
  | "ImpactAffiliateNetwork"
  | "JinsoonShopify"
  | "KathleenAndCoShopify"
  | "KiaraSkyShopify"
  | "LeMiniMacaronShopify"
  | "LemmingLacquerShopify"
  | "LightsLacquerShopify"
  | "LondontownShopify"
  | "LoudBabbsShopify"
  | "MakeupAPI"
  | "ManucuristShopify"
  | "MavalaShopify"
  | "ModelonesShopify"
  | "MoonShineManiShopify"
  | "MooncatShopify"
  | "NailHootShopify"
  | "NailberryShopify"
  | "NightOwlLacquerShopify"
  | "NoodlesNailPolishShopify"
  | "OliveAndJuneShopify"
  | "OliveAvePolishShopify"
  | "OpenBeautyFacts"
  | "OpiSitemap"
  | "OrlyShopify"
  | "PacificaShopify"
  | "PahlishShopify"
  | "PaintItPrettyPolishShopify"
  | "PenelopeLuzShopify"
  | "PiggyPaintShopify"
  | "PolishPickupShopify"
  | "PotionPolishShopify"
  | "PrismParadeShopify"
  | "RakutenAdvertising"
  | "RedEyedLacquerShopify"
  | "RevlonShopify"
  | "RogueLacquerShopify"
  | "RoylaleeShopify"
  | "SassysaucePolishShopify"
  | "StarrilyShopify"
  | "StaticNailsShopify"
  | "StellaChromaShopify"
  | "SundaysShopify"
  | "SweetAndSourLacquerShopify"
  | "TenovertenShopify"
  | "TylerStrinketsShopify"
  | "UserCapture"
  | "WetNWildShopify"
  | "ZombieClawPolishShopify"
  | "openFDA_CosmeticEvents";

/** Maps each connector source to its protocol group for UI grouping and bulk selection. */
export const SOURCE_PROTOCOL_MAP: Record<SupportedConnectorSource, ConnectorProtocol> = {
  AlchemyLacquersShopify: "Shopify",
  AnchorAndHeartShopify: "Shopify",
  BarryMShopify: "Shopify",
  BeesKneesLacquerShopify: "Shopify",
  BeyondPolishShopify: "Shopify",
  ButterLondonShopify: "Shopify",
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
  DazzleDryShopify: "Shopify",
  DeborahLippmannShopify: "Shopify",
  DndShopify: "Shopify",
  DreamlandLacquerShopify: "Shopify",
  DrunkFairyPolishShopify: "Shopify",
  EllaMilaShopify: "Shopify",
  EmilyDeMollyShopify: "Shopify",
  EtherealLacquerShopify: "Shopify",
  FunLacquerShopify: "Shopify",
  GS1Lookup: "GS1",
  GardenPathLacquersShopify: "Shopify",
  GlamPolishShopify: "Shopify",
  GreatLakesLacquerShopify: "Shopify",
  HarlowAndCoShopify: "Shopify",
  HoloTacoShopify: "HoloTaco",
  HypnoticPolishShopify: "Shopify",
  ImpactAffiliateNetwork: "Custom",
  JinsoonShopify: "Shopify",
  KathleenAndCoShopify: "Shopify",
  KiaraSkyShopify: "Shopify",
  LeMiniMacaronShopify: "Shopify",
  LemmingLacquerShopify: "Shopify",
  LightsLacquerShopify: "Shopify",
  LondontownShopify: "Shopify",
  LoudBabbsShopify: "Shopify",
  MakeupAPI: "MakeupAPI",
  ManucuristShopify: "Shopify",
  MavalaShopify: "Shopify",
  ModelonesShopify: "Shopify",
  MoonShineManiShopify: "Shopify",
  MooncatShopify: "Shopify",
  NailHootShopify: "Shopify",
  NailberryShopify: "Shopify",
  NightOwlLacquerShopify: "Shopify",
  NoodlesNailPolishShopify: "Shopify",
  OliveAndJuneShopify: "Shopify",
  OliveAvePolishShopify: "Shopify",
  OpenBeautyFacts: "OpenBeautyFacts",
  OpiSitemap: "SitemapJsonLd",
  OrlyShopify: "Shopify",
  PacificaShopify: "Shopify",
  PahlishShopify: "Shopify",
  PaintItPrettyPolishShopify: "Shopify",
  PenelopeLuzShopify: "Shopify",
  PiggyPaintShopify: "Shopify",
  PolishPickupShopify: "Shopify",
  PotionPolishShopify: "Shopify",
  PrismParadeShopify: "Shopify",
  RakutenAdvertising: "Custom",
  RedEyedLacquerShopify: "Shopify",
  RevlonShopify: "Shopify",
  RogueLacquerShopify: "Shopify",
  RoylaleeShopify: "Shopify",
  SassysaucePolishShopify: "Shopify",
  StarrilyShopify: "Shopify",
  StaticNailsShopify: "Shopify",
  StellaChromaShopify: "Shopify",
  SundaysShopify: "Shopify",
  SweetAndSourLacquerShopify: "Shopify",
  TenovertenShopify: "Shopify",
  TylerStrinketsShopify: "Shopify",
  UserCapture: "Custom",
  WetNWildShopify: "Shopify",
  ZombieClawPolishShopify: "Shopify",
  openFDA_CosmeticEvents: "Custom",
};

// Runtime array for validation - same values as the type above
export const SUPPORTED_SOURCES: SupportedConnectorSource[] = [
  "AlchemyLacquersShopify",
  "AnchorAndHeartShopify",
  "BarryMShopify",
  "BeesKneesLacquerShopify",
  "BeyondPolishShopify",
  "ButterLondonShopify",
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
  "DazzleDryShopify",
  "DeborahLippmannShopify",
  "DndShopify",
  "DreamlandLacquerShopify",
  "DrunkFairyPolishShopify",
  "EllaMilaShopify",
  "EmilyDeMollyShopify",
  "EtherealLacquerShopify",
  "FunLacquerShopify",
  "GS1Lookup",
  "GardenPathLacquersShopify",
  "GlamPolishShopify",
  "GreatLakesLacquerShopify",
  "HarlowAndCoShopify",
  "HoloTacoShopify",
  "HypnoticPolishShopify",
  "ImpactAffiliateNetwork",
  "JinsoonShopify",
  "KathleenAndCoShopify",
  "KiaraSkyShopify",
  "LeMiniMacaronShopify",
  "LemmingLacquerShopify",
  "LightsLacquerShopify",
  "LondontownShopify",
  "LoudBabbsShopify",
  "MakeupAPI",
  "ManucuristShopify",
  "MavalaShopify",
  "ModelonesShopify",
  "MoonShineManiShopify",
  "MooncatShopify",
  "NailHootShopify",
  "NailberryShopify",
  "NightOwlLacquerShopify",
  "NoodlesNailPolishShopify",
  "OliveAndJuneShopify",
  "OliveAvePolishShopify",
  "OpenBeautyFacts",
  "OpiSitemap",
  "OrlyShopify",
  "PacificaShopify",
  "PahlishShopify",
  "PaintItPrettyPolishShopify",
  "PenelopeLuzShopify",
  "PiggyPaintShopify",
  "PolishPickupShopify",
  "PotionPolishShopify",
  "PrismParadeShopify",
  "RakutenAdvertising",
  "RedEyedLacquerShopify",
  "RevlonShopify",
  "RogueLacquerShopify",
  "RoylaleeShopify",
  "SassysaucePolishShopify",
  "StarrilyShopify",
  "StaticNailsShopify",
  "StellaChromaShopify",
  "SundaysShopify",
  "SweetAndSourLacquerShopify",
  "TenovertenShopify",
  "TylerStrinketsShopify",
  "UserCapture",
  "WetNWildShopify",
  "ZombieClawPolishShopify",
  "openFDA_CosmeticEvents",
];
