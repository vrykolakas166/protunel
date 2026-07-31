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
          ? "border-b border-red-200 bg-red-100 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          : "border-b border-neutral-200 bg-neutral-100 px-4 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
      }
    >
      {text}
    </div>
  );
}
