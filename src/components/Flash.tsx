import { Badge } from "./ui";

/** Result message after an action. Success is announced politely; an error is announced immediately. */
export function Flash({ message, error }: { message?: string; error?: string }) {
  if (error) {
    return (
      <div className="alert alert--error" role="alert">
        <Badge tone="critical">Error</Badge> {error}
      </div>
    );
  }
  if (!message) return null;
  return (
    <div className="alert" role="status">
      {message}
    </div>
  );
}
