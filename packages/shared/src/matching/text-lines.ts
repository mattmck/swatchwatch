/**
 * Turns on-device text recognition output (Apple Vision, ML Kit) into the phrases and tokens
 * the bottle text matcher compares against catalog names.
 */

/** One recognised line of text; `x`/`y` are the centre of its box as 0–1 fractions of the image. */
export interface RecognizedTextLine {
  text: string;
  /** Recogniser confidence, 0–1. */
  confidence: number;
  x: number;
  y: number;
}

/** Inclusive bounds of the part of the image whose text counts, on both axes. */
export interface TextRegion {
  min: number;
  max: number;
}

/**
 * Default centre-only region. Text near the edge of a bottle photo is background (shelf labels,
 * other bottles), so only lines whose box centre lies in 0.18–0.82 on both axes are used.
 */
export const DEFAULT_TEXT_REGION: Readonly<TextRegion> = { min: 0.18, max: 0.82 };

export interface TextPhraseOptions {
  /** Lines below this recogniser confidence are dropped. Default 0.3. */
  minConfidence?: number;
  /** Centre-only region; `null` keeps every line. Default {@link DEFAULT_TEXT_REGION}. */
  region?: TextRegion | null;
  /**
   * How many adjacent lines are joined into one phrase: 1 = single lines, 2 = also pairs (both
   * orders), 3 = also triples (forward and reversed). Names wrap over lines. Default 3.
   */
  maxJoin?: 1 | 2 | 3;
}

export const DEFAULT_TEXT_MIN_CONFIDENCE = 0.3;

export interface TextPhrases {
  /** Distinct raw (not normalised) phrases: single lines and joined adjacent lines. */
  phrases: string[];
  /** Distinct raw tokens: each whitespace-separated word and each line with its spaces removed. */
  tokens: string[];
}

/**
 * Build the phrases and tokens of one or more recognitions of the same bottle (several photos,
 * or the same photo at several rotations). Lines are filtered per recognition first, and joined
 * lines are adjacent in that filtered list, never across two recognitions.
 */
export function buildTextPhrases(
  recognitions: ReadonlyArray<ReadonlyArray<RecognizedTextLine>>,
  options: TextPhraseOptions = {},
): TextPhrases {
  const minConfidence = options.minConfidence ?? DEFAULT_TEXT_MIN_CONFIDENCE;
  const region = options.region === undefined ? DEFAULT_TEXT_REGION : options.region;
  const maxJoin = options.maxJoin ?? 3;
  const phrases = new Set<string>();
  const tokens = new Set<string>();
  for (const recognition of recognitions) {
    const texts: string[] = [];
    for (const line of recognition) {
      if (line.confidence < minConfidence) continue;
      if (region && !(region.min <= line.x && line.x <= region.max && region.min <= line.y && line.y <= region.max)) continue;
      texts.push(line.text);
    }
    for (let i = 0; i < texts.length; i += 1) {
      const t = texts[i];
      phrases.add(t);
      if (maxJoin >= 2 && i + 1 < texts.length) {
        phrases.add(`${t} ${texts[i + 1]}`);
        phrases.add(`${texts[i + 1]} ${t}`);
      }
      for (const token of t.split(/\s+/)) tokens.add(token);
      tokens.add(t.replace(/ /g, ""));
    }
    if (maxJoin >= 3) {
      for (let i = 0; i + 2 < texts.length; i += 1) {
        phrases.add(`${texts[i]} ${texts[i + 1]} ${texts[i + 2]}`);
        phrases.add(`${texts[i + 2]} ${texts[i + 1]} ${texts[i]}`);
      }
    }
  }
  return { phrases: [...phrases], tokens: [...tokens] };
}
