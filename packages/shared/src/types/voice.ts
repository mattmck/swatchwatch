export interface VoiceProcessRequest {
  audioFormat: "wav" | "webm" | "ogg" | "mp3";
}

export interface ParsedPolishDetails {
  brand?: string;
  name?: string;
  color?: string;
  finish?: string;
  collection?: string;
  quantity?: number;
  confidence: number;
  rawTranscription: string;
}

export interface VoiceProcessResponse {
  parsed: ParsedPolishDetails;
  suggestions?: ParsedPolishDetails[];
}

export type VoiceCommand =
  | { action: "add"; details: ParsedPolishDetails }
  | { action: "update"; polishId: string; details: Partial<ParsedPolishDetails> }
  | { action: "delete"; polishId: string }
  | { action: "search"; query: string };
