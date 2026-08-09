import { App, Modal, Setting } from 'obsidian';

export class GroupDescriptionModal extends Modal {
	private description: string;

	constructor(
		app: App,
		private heading: string,
		private placeholder: string,
		initialDescription: string,
		private onSubmit: (description: string) => void
	) {
		super(app);
		this.description = initialDescription;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: this.heading });

		new Setting(contentEl).addTextArea((text) => {
			text
				.setPlaceholder(this.placeholder)
				.setValue(this.description)
				.onChange((value) => (this.description = value));
			text.inputEl.focus();
		});

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText('Save')
				.setCta()
				.onClick(() => {
					this.onSubmit(this.description.trim());
					this.close();
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
