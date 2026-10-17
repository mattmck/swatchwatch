"use client";

import { useState } from "react";
import type { CaptureQuestion } from "swatchwatch-shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { buildQuestionView, type QuestionAction } from "@/lib/rapid-add-flow";

export interface CaptureQuestionPanelProps {
  question: CaptureQuestion;
  busy: boolean;
  onAnswer: (answer: string, displayHint?: string) => void;
  onSkip: () => void;
  onAction: (action: QuestionAction) => void;
}

/** Renders the capture API's adaptive follow-up question as buttons (plus free text). */
export function CaptureQuestionPanel({ question, busy, onAnswer, onSkip, onAction }: CaptureQuestionPanelProps) {
  const view = buildQuestionView(question);
  const [text, setText] = useState("");

  return (
    <section className="space-y-3 rounded-xl border border-brand-purple/30 bg-brand-pink-light/10 p-4">
      <p className="text-sm font-medium">{view.prompt}</p>

      {view.choices.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {view.choices.map((choice) =>
            choice.kind === "answer" ? (
              <Button
                key={choice.value}
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onAnswer(choice.value, choice.label)}
              >
                {choice.label}
              </Button>
            ) : (
              <Button
                key={choice.action}
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => onAction(choice.action)}
              >
                {choice.label}
              </Button>
            ),
          )}
        </div>
      )}

      {view.allowsFreeText && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim()) {
              onAnswer(text.trim());
              setText("");
            }
          }}
        >
          <Input
            aria-label="Brand and shade"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Brand — shade (e.g. OPI — Big Apple Red)"
          />
          <Button type="submit" variant="outline" disabled={busy || !text.trim()}>
            Submit
          </Button>
        </form>
      )}

      {view.canSkip && (
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onSkip}>
          Skip
        </Button>
      )}
    </section>
  );
}
