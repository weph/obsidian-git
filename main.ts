import { Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import simpleGit, { CheckRepoActions, SimpleGit } from "simple-git";
import { FileStatusResult } from "simple-git/typings/response";

enum PluginState {
    idle,
    status,
    pull,
    add,
    commit,
    push,
}

export default class ObsidianGit extends Plugin {
    public git: SimpleGit;
    public settings: ObsidianGitSettings;
    public statusBar: StatusBar;
    public state: PluginState = PluginState.idle;
    public intervalID: number;

    private lastUpdate: number;

    setState(state: PluginState) {
        this.state = state;
        this.refreshStatusBar();
    }

    getState(): PluginState {
        return this.state;
    }

    async onload() {
        let statusBarEl = this.addStatusBarItem();
        this.statusBar = new StatusBar(statusBarEl);
        this.setState(PluginState.idle);

        const adapter: any = this.app.vault.adapter;
        const git = simpleGit(adapter.basePath);

        let isValidRepo = git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
        if (!isValidRepo) {
            this.displayMessage("Valid git repository not found.", 0);
            return;
        }

        this.git = git;
        this.settings = (await this.loadData()) || new ObsidianGitSettings();

        // resolve current branch and remote
        let branchInfo = await git.branch();
        this.settings.currentBranch = branchInfo.current;

        let remote = await git.remote([]);
        if (typeof remote === "string") {
            this.settings.remote = remote.trim();
        } else {
            this.displayMessage("Failed to detect remote.", 0);
            return;
        }

        if (this.settings.autoPullOnBoot) {
            await this.pull().then((filesUpdated) => {
                this.setState(PluginState.idle);
                let message =
                    filesUpdated > 0
                        ? `Pulled new changes. ${filesUpdated} files updated`
                        : "Everything up-to-date";
                this.displayMessage(message);
            });
        }

        if (this.settings.autoSaveInterval > 0) {
            this.enableAutoBackup();
        }

        this.registerInterval(
            window.setInterval(() => this.refreshStatusBar(), 1000)
        );

        this.addSettingTab(new ObsidianGitSettingsTab(this.app, this));

        this.addCommand({
            id: "pull",
            name: "Pull from remote repository",
            callback: async () => this.pullChangesFromRemote()
        });

        this.addCommand({
            id: "push",
            name: "Commit *all* changes and push to remote repository",
            callback: async () =>
                await this.getFilesChanged().then(async (files) => {
                    if (!files.length) {
                        this.displayMessage("No changes detected");

                        return;
                    }

                    await this.createBackup();
                }),
        });
    }

    async pullChangesFromRemote() {
        await this.pull().then((filesUpdated) => {
            if (filesUpdated > 0) {
                this.displayMessage(
                    `Pulled new changes. ${filesUpdated} files updated`
                );
            } else {
                this.displayMessage("Everything is up-to-date");
            }
        });

        this.setState(PluginState.idle);
    }

    async createBackup() {
        await this.getFilesChanged().then(async (files) => {
            if (files.length === 0) {
                return;
            }

            await this.add()
                .then(async () => await this.commit())
                .then(() => this.displayMessage(`Committed ${files.length} files`));

            if (this.settings.autoPush) {
                await this.push()
                    .then(() => this.displayMessage(`Pushed ${files.length} files to remote`));
            }
        })

        this.setState(PluginState.idle);
    }

    async onunload() {
        await this.saveData(this.settings);
    }

    // region: main methods
    async getFilesChanged(): Promise<FileStatusResult[]> {
        this.setState(PluginState.status);
        let status = await this.git.status();
        return status.files;
    }

    async add(): Promise<void> {
        this.setState(PluginState.add);
        await this.git.add(
            "./*",
            (err: Error | null) =>
                err && this.displayError(`Cannot add files: ${err.message}`)
        );
    }

    async commit(): Promise<void> {
        this.setState(PluginState.commit);
        let commitMessage = await this.formatCommitMessage(
            this.settings.commitMessage
        );
        await this.git.commit(commitMessage);
    }

    async push(): Promise<void> {
        this.setState(PluginState.push);
        await this.git.push(
            this.settings.remote,
            this.settings.currentBranch,
            null,
            (err: Error | null) => {
                err && this.displayError(`Push failed ${err.message}`);
            }
        );

        this.lastUpdate = Date.now();
    }

    async pull(): Promise<number> {
        this.setState(PluginState.pull);
        let pullResult = await this.git.pull(
            null,
            null,
            null,
            (err: Error | null) =>
                err && this.displayError(`Pull failed ${err.message}`)
        );
        this.lastUpdate = Date.now();
        return pullResult.files.length;
    }

    // endregion: main methods

    enableAutoBackup() {
        let minutes = this.settings.autoSaveInterval;
        this.intervalID = window.setInterval(
            async () => await this.createBackup(),
            minutes * 60000
        );
        this.registerInterval(this.intervalID);
    }

    disableAutoBackup(): boolean {
        if (this.intervalID) {
            clearInterval(this.intervalID);
            return true;
        }

        return false;
    }

    // region: displaying / formatting messages
    displayMessage(message: string, timeout: number = 4 * 1000): void {
        this.statusBar.displayMessage(message.toLowerCase(), timeout);

        if (!this.settings.disablePopups) {
            new Notice(message);
        }

        console.log(`git obsidian: ${message}`);
    }

    displayError(message: string, timeout: number = 0): void {
        new Notice(message);
        this.statusBar.displayMessage(message.toLowerCase(), timeout);
    }

    refreshStatusBar(): void {
        this.statusBar.displayState(this.getState(), this.lastUpdate);
    }

    async formatCommitMessage(template: string): Promise<string> {
        if (template.includes("{{numFiles}}")) {
            let statusResult = await this.git.status();
            let numFiles = statusResult.files.length;
            template = template.replace("{{numFiles}}", String(numFiles));
        }

        let moment = (window as any).moment;
        return template.replace(
            "{{date}}",
            moment().format(this.settings.commitDateFormat)
        );
    }

    // endregion: displaying / formatting stuff
}

class ObsidianGitSettings {
    commitMessage: string = "vault backup: {{date}}";
    commitDateFormat: string = "YYYY-MM-DD HH:mm:ss";
    autoSaveInterval: number = 0;
    autoPullOnBoot: boolean = false;
    autoPush: boolean = true;
    disablePopups: boolean = false;
    currentBranch: string;
    remote: string;
}

class ObsidianGitSettingsTab extends PluginSettingTab {
    display(): void {
        let { containerEl } = this;
        const plugin: ObsidianGit = (this as any).plugin;

        containerEl.empty();
        containerEl.createEl("h2", { text: "Git Backup settings" });

        new Setting(containerEl)
            .setName("Vault backup interval (minutes)")
            .setDesc(
                "Commit and push changes every X minutes. To disable automatic backup, specify negative value or zero (default)"
            )
            .addText((text) =>
                text
                    .setValue(String(plugin.settings.autoSaveInterval))
                    .onChange((value) => {
                        if (!isNaN(Number(value))) {
                            plugin.settings.autoSaveInterval = Number(value);
                            plugin.saveData(plugin.settings);

                            if (plugin.settings.autoSaveInterval > 0) {
                                plugin.disableAutoBackup(); // call clearInterval() before setting up a new one
                                plugin.enableAutoBackup();
                                new Notice(
                                    `Automatic backup enabled! Every ${plugin.settings.autoSaveInterval} minutes.`
                                );
                            } else if (
                                plugin.settings.autoSaveInterval <= 0 &&
                                plugin.intervalID
                            ) {
                                plugin.disableAutoBackup() &&
                                    new Notice("Automatic backup disabled!");
                            }
                        } else {
                            new Notice("Please specify a valid number.");
                        }
                    })
            );

        new Setting(containerEl)
            .setName("Commit message")
            .setDesc(
                "Specify custom commit message. Available placeholders: {{date}}" +
                    " (see below) and {{numFiles}} (number of changed files in the commit)"
            )
            .addText((text) =>
                text
                    .setPlaceholder("vault backup")
                    .setValue(
                        plugin.settings.commitMessage
                            ? plugin.settings.commitMessage
                            : ""
                    )
                    .onChange((value) => {
                        plugin.settings.commitMessage = value;
                        plugin.saveData(plugin.settings);
                    })
            );

        new Setting(containerEl)
            .setName("{{date}} placeholder format")
            .setDesc('Specify custom date format. E.g. "YYYY-MM-DD HH:mm:ss"')
            .addText((text) =>
                text
                    .setPlaceholder(plugin.settings.commitDateFormat)
                    .setValue(plugin.settings.commitDateFormat)
                    .onChange(async (value) => {
                        plugin.settings.commitDateFormat = value;
                        await plugin.saveData(plugin.settings);
                    })
            );

        new Setting(containerEl)
            .setName("Preview commit message")
            .addButton((button) =>
                button.setButtonText("Preview").onClick(async () => {
                    let commitMessagePreview = await plugin.formatCommitMessage(
                        plugin.settings.commitMessage
                    );
                    new Notice(`${commitMessagePreview}`);
                })
            );

        new Setting(containerEl)
            .setName("Current branch")
            .setDesc("Switch to a different branch")
            .addDropdown(async (dropdown) => {
                let branchInfo = await plugin.git.branchLocal();
                for (const branch of branchInfo.all) {
                    dropdown.addOption(branch, branch);
                }
                dropdown.setValue(branchInfo.current);
                dropdown.onChange(async (option) => {
                    await plugin.git.checkout(
                        option,
                        [],
                        async (err: Error) => {
                            if (err) {
                                new Notice(err.message);
                                dropdown.setValue(branchInfo.current);
                            } else {
                                new Notice(`Checked out to ${option}`);
                                plugin.settings.currentBranch = option;
                                await plugin.saveData(plugin.settings);
                            }
                        }
                    );
                });
            });

        new Setting(containerEl)
            .setName("Pull updates on startup")
            .setDesc("Automatically pull updates when Obsidian starts")
            .addToggle((toggle) =>
                toggle
                    .setValue(plugin.settings.autoPullOnBoot)
                    .onChange((value) => {
                        plugin.settings.autoPullOnBoot = value;
                        plugin.saveData(plugin.settings);
                    })
            );

        new Setting(containerEl)
            .setName("Push changes")
            .setDesc("Automatically push changes to the remote repository")
            .addToggle((toggle) =>
                toggle
                    .setValue(plugin.settings.autoPush)
                    .onChange((value) => {
                        plugin.settings.autoPush = value;
                        plugin.saveData(plugin.settings);
                    })
            );

        new Setting(containerEl)
            .setName("Disable notifications")
            .setDesc(
                "Disable notifications for git operations to minimize distraction (refer to status bar for updates)"
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(plugin.settings.disablePopups)
                    .onChange((value) => {
                        plugin.settings.disablePopups = value;
                        plugin.saveData(plugin.settings);
                    })
            );
    }
}

class StatusBar {
    private statusBarEl: HTMLElement;
    private isDisplayingMessage: boolean = false;

    constructor(statusBarEl: HTMLElement) {
        this.statusBarEl = statusBarEl;
    }

    displayMessage(message: string, timeout: number) {
        this.isDisplayingMessage = true;
        this.statusBarEl.setText(`git: ${message.slice(0, 100)}`);

        if (timeout && timeout > 0) {
            window.setTimeout(() => {
                this.isDisplayingMessage = false;
            }, timeout);
        }
    }

    displayState(state: PluginState, lastUpdate: number) {
        if (this.isDisplayingMessage) {
            return;
        }

        switch (state) {
            case PluginState.idle:
                this.displayFromNow(lastUpdate);
                break;
            case PluginState.status:
                this.statusBarEl.setText("git: checking repo status..");
                break;
            case PluginState.add:
                this.statusBarEl.setText("git: adding files to repo..");
                break;
            case PluginState.commit:
                this.statusBarEl.setText("git: committing changes..");
                break;
            case PluginState.push:
                this.statusBarEl.setText("git: pushing changes..");
                break;
            case PluginState.pull:
                this.statusBarEl.setText("git: pulling changes..");
                break;
        }
    }

    displayFromNow(timestamp: number): void {
        if (timestamp) {
            let moment = (window as any).moment;
            let fromNow = moment(timestamp).fromNow();
            this.statusBarEl.setText(`git: last update ${fromNow}..`);
        } else {
            this.statusBarEl.setText(`git: ready`);
        }
    }
}
