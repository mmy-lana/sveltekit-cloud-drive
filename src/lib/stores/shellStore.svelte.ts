/**
 * Shell commands.
 *
 * Two actions are owned by the layout — the file picker and the new-folder
 * dialog — but are triggered from three different tiers of the chrome *and*
 * from the listing's empty states. Threading them down as props from the
 * layout to every route to every view would mean four routes carrying the same
 * two callbacks forever.
 *
 * So the layout registers the commands and anyone who needs one calls it. This
 * is a deliberate exception to "components take props": it models chrome
 * actions that genuinely have no parent-child relationship with their triggers,
 * and it is the standard fix for that problem rather than a convenience. The
 * registration is idempotent and is torn down with the layout, so a command
 * can never outlive the control it points at — a stale callback would open a
 * file picker whose input has been removed from the document.
 */
class ShellStore {
  #openUploadPicker = $state<(() => void) | null>(null);
  #openCreateFolder = $state<(() => void) | null>(null);

  /**
   * Point the shell at its real controls. Called by the layout on mount and
   * again on teardown, which is why it takes and returns a cleanup rather than
   * being a plain setter.
   */
  register(commands: { openUploadPicker: () => void; openCreateFolder: () => void }): () => void {
    this.#openUploadPicker = commands.openUploadPicker;
    this.#openCreateFolder = commands.openCreateFolder;
    return () => {
      if (this.#openUploadPicker === commands.openUploadPicker) this.#openUploadPicker = null;
      if (this.#openCreateFolder === commands.openCreateFolder) this.#openCreateFolder = null;
    };
  }

  /** `true` once the layout has registered its controls. */
  get isReady(): boolean {
    return this.#openUploadPicker !== null && this.#openCreateFolder !== null;
  }

  /** Open the shared file picker. A no-op before the shell has mounted. */
  openUploadPicker(): void {
    this.#openUploadPicker?.();
  }

  /** Open the shared new-folder dialog. A no-op before the shell has mounted. */
  openCreateFolderDialog(): void {
    this.#openCreateFolder?.();
  }
}

export const shellStore = new ShellStore();
