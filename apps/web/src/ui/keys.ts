/**
 * Whether a key event is aimed at a field the user is typing in (a text input,
 * a text area, a drop-down list or editable text). The editor's single-key
 * shortcuts (tools, Delete, R, …) leave those keys to the field: in a
 * drop-down, letters jump to an option, and Delete or Backspace edit text.
 */
export function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
