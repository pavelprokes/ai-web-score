import { llmModelAction } from "@/app/(admin)/actions";
import { LLM_MODEL_OPTIONS, LLM_TASKS, llmPrice, type LlmTask } from "@/lib/llm";
import { SubmitButton } from "./SubmitButton";
import { Section } from "./ui";

/** Which Claude model each internal task uses; one form, saved together. */
export function InternalModels({ current }: { current: Record<LlmTask, string> }) {
  const price = (id: string) => {
    const p = llmPrice(id);
    return p ? ` — $${p.input} / $${p.output} per MTok` : "";
  };
  return (
    <Section title="Internal AI models" id="models-heading">
      <p className="note">
        Models this app uses for its own work (not the assistants it measures). Prices are per million input / output tokens. A saved
        choice applies to the next call and overrides the environment variables.
      </p>
      <form action={llmModelAction} className="models-form">
        {(Object.keys(LLM_TASKS) as LlmTask[]).map((task) => (
          <div key={task} className="models-form__row">
            <label htmlFor={`model-${task}`}>
              <strong>{LLM_TASKS[task].label}</strong>
              <span className="muted"> {LLM_TASKS[task].detail}</span>
            </label>
            <select id={`model-${task}`} name={task} defaultValue={current[task]}>
              {LLM_MODEL_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {`${o.label} (${o.note})${price(o.id)}${o.id === LLM_TASKS[task].default ? " · recommended" : ""}`}
                </option>
              ))}
            </select>
          </div>
        ))}
        <SubmitButton className="btn" pendingLabel="Saving…">
          Save models
        </SubmitButton>
      </form>
    </Section>
  );
}
