import { App, Modal, Setting } from 'obsidian';

export class ConfirmCompleteModal extends Modal {
	private dontAskAgain = false;

	constructor(
		app: App,
		private groupTitle: string,
		private onConfirm: (dontAskAgain: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: `Complete "${this.groupTitle}"?` });
		contentEl.createEl('p', {
			text: 'Its tabs will close and it moves to completed, where you can restore it anytime.',
		});

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText('Complete')
					.setCta()
					.onClick(() => {
						this.onConfirm(this.dontAskAgain);
						this.close();
					})
			);

		const checkboxRow = contentEl.createDiv({ cls: 'working-tabs-checkbox-row' });
		const checkbox = checkboxRow.createEl('input', { attr: { type: 'checkbox', id: 'working-tabs-dont-ask' } });
		checkbox.addEventListener('change', () => (this.dontAskAgain = checkbox.checked));
		checkboxRow.createEl('label', { text: "Don't ask again", attr: { for: 'working-tabs-dont-ask' } });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
