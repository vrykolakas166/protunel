interface Props {
  text: string | null;
  isError: boolean;
}

export function MessageBar({ text, isError }: Props) {
  if (!text) return null;

  return (
    <div
      className={
        isError
          ? "border-b border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral"
          : "border-b border-border bg-surface px-4 py-2 text-sm text-muted"
      }
    >
      {text}
    </div>
  );
}
